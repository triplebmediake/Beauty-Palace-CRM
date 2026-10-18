// Staff profiles: contact details, ID, employment date, absences, and lifetime performance.
import { AppError } from '../errors.js';

const PHOTO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_PHOTO_BYTES = 500 * 1024;
export const ABSENCE_KINDS = { absent: 'Absent (no notice)', sick: 'Sick', leave: 'Approved leave', late: 'Late / left early' };
const bad = (m) => new AppError(422, 'BAD_STAFF', m);
const dateOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(s)) && String(s) >= '1990-01-01';

export function registerStaffRoutes(app, { db, tx, secure, branchList, v: { int } }) {
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
  const person = (x) => ({ id: Number(x.id), name: x.display_name, phone: x.phone, email: x.email, branchId: Number(x.branch_id), branch: x.branch, specialty: x.specialty, active: x.is_active, hiredOn: x.hired_on });

  app.get('/staff', ...secure('staff.view'), async (req, res) => {
    const br = branchList(req.user, req.query.branchId);
    const r = await db.query(
      `SELECT t.id, t.display_name, t.phone, t.email, t.branch_id, b.name AS branch, sc.code AS specialty, t.is_active, t.hired_on::text AS hired_on,
              COALESCE(s.sales, 0) AS lifetime_sales, COALESCE(s.customers, 0) AS customers,
              (SELECT COUNT(*) FROM staff_absences a WHERE a.technician_id = t.id AND a.absent_on >= (CURRENT_DATE - 90) AND a.kind <> 'late')::int AS absences_90
         FROM technicians t JOIN branches b ON b.id = t.branch_id LEFT JOIN service_categories sc ON sc.id = t.specialty_category_id
         LEFT JOIN (SELECT cr.technician_id, SUM(cr.amount) AS sales, COUNT(DISTINCT tr.customer_id) AS customers
                      FROM v_item_credits cr JOIN transactions tr ON tr.id = cr.transaction_id AND tr.status <> 'voided'
                     GROUP BY cr.technician_id) s ON s.technician_id = t.id
        WHERE ($1::bigint[] IS NULL OR t.branch_id = ANY($1)) ORDER BY t.is_active DESC, t.display_name`, [br]);
    res.json({ canManage: req.user.permissions.has('staff.manage'),
      rows: r.rows.map((x) => ({ ...person(x), lifetimeSales: Number(x.lifetime_sales), customers: Number(x.customers), absences90: x.absences_90 })) });
  });

  app.get('/staff/:id', ...secure('staff.view'), async (req, res) => {
    const id = int(req.params.id, 'staff member'), manage = req.user.permissions.has('staff.manage');
    const t = await db.query(
      `SELECT t.id, t.display_name, t.phone, t.email, t.branch_id, b.name AS branch, sc.code AS specialty, t.is_active, t.hired_on::text AS hired_on, t.national_id, (t.id_photo IS NOT NULL) AS has_photo
         FROM technicians t JOIN branches b ON b.id = t.branch_id LEFT JOIN service_categories sc ON sc.id = t.specialty_category_id WHERE t.id = $1`, [id]);
    if (!t.rowCount) throw new AppError(404, 'NOT_FOUND', 'Staff member not found');
    const [tot, top, abs, last] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(cr.amount),0) AS sales, COUNT(*)::int AS services, COUNT(DISTINCT tr.customer_id)::int AS customers, COUNT(DISTINCT (tr.customer_id, tr.business_date))::int AS visits,
                       MIN(tr.business_date)::text AS first_sale, MAX(tr.business_date)::text AS last_sale
                  FROM v_item_credits cr JOIN transactions tr ON tr.id = cr.transaction_id AND tr.status <> 'voided'
                 WHERE cr.technician_id = $1`, [id]),
      db.query(`SELECT cr.description AS service, COUNT(*)::int AS times, SUM(cr.amount) AS revenue
                  FROM v_item_credits cr JOIN transactions tr ON tr.id = cr.transaction_id AND tr.status <> 'voided'
                 WHERE cr.technician_id = $1 GROUP BY cr.description ORDER BY COUNT(*) DESC, SUM(cr.amount) DESC LIMIT 5`, [id]),
      db.query(`SELECT a.id, a.absent_on::text AS date, a.kind, a.reason, u.full_name AS by FROM staff_absences a LEFT JOIN users u ON u.id = a.recorded_by
                 WHERE a.technician_id = $1 ORDER BY a.absent_on DESC, a.id DESC LIMIT 60`, [id]),
      db.query(`SELECT COUNT(*) FILTER (WHERE kind <> 'late' AND absent_on >= (CURRENT_DATE - 90))::int AS d90, COUNT(*) FILTER (WHERE kind <> 'late' AND absent_on >= date_trunc('year', CURRENT_DATE))::int AS year
                  FROM staff_absences WHERE technician_id = $1`, [id]),
    ]);
    const x = t.rows[0], s = tot.rows[0];
    res.json({ ...person(x), canManage: manage, nationalId: manage ? x.national_id : undefined, hasIdPhoto: manage ? x.has_photo : undefined,
      lifetime: { sales: Number(s.sales), services: s.services, customers: s.customers, visits: s.visits, firstSale: s.first_sale, lastSale: s.last_sale, since: x.hired_on || s.first_sale },
      topServices: top.rows.map((r) => ({ service: r.service, times: r.times, revenue: Number(r.revenue) })),
      absences: abs.rows.map((r) => ({ id: Number(r.id), date: r.date, kind: r.kind, reason: r.reason || '', by: r.by })), absencesLast90: last.rows[0].d90, absencesThisYear: last.rows[0].year, kinds: ABSENCE_KINDS });
  });

  app.get('/staff/:id/id-photo', ...secure('staff.manage'), async (req, res) => {
    const r = await db.query(`SELECT id_photo FROM technicians WHERE id = $1`, [int(req.params.id, 'staff member')]);
    if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Staff member not found');
    res.json({ photo: r.rows[0].id_photo });
  });

  app.put('/staff/:id', ...secure('staff.manage'), async (req, res) => {
    const id = int(req.params.id, 'staff member'), b = req.body || {}, sets = [], vals = [id], add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    const str = (k, max) => { const t = String(b[k] ?? '').trim(); if (t.length > max) throw bad(`That ${k} is too long`); return t || null; };
    if (b.displayName !== undefined) { const n = str('displayName', 80); if (!n) throw bad('The name cannot be empty'); add('display_name', n); }
    if (b.phone !== undefined) { const p = str('phone', 30); if (p && !/^[0-9+() \-]{7,20}$/.test(p)) throw bad('That phone number does not look right'); add('phone', p); }
    if (b.email !== undefined) { const e = str('email', 120); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw bad('That email address does not look right'); add('email', e); }
    if (b.nationalId !== undefined) { const n = str('nationalId', 30); if (n && !/^[A-Za-z0-9\- ]{4,30}$/.test(n)) throw bad('That ID number does not look right'); add('national_id', n); }
    if (b.hiredOn !== undefined) { const d = str('hiredOn', 10); if (d && (!dateOk(d) || d > today())) throw bad('Date of employment must be a valid date, not in the future'); add('hired_on', d); }
    if (b.active !== undefined) add('is_active', !!b.active);
    if (b.idPhoto !== undefined) {
      if (b.idPhoto === null || b.idPhoto === '') add('id_photo', null);
      else { if (!PHOTO_RE.test(b.idPhoto)) throw bad('The ID picture must be a PNG, JPG or WebP image');
        if (Buffer.byteLength(b.idPhoto) * 0.75 > MAX_PHOTO_BYTES) throw bad('That picture is too large. Use a smaller photo (under 500 KB)'); add('id_photo', b.idPhoto); }
    }
    if (!sets.length) throw bad('Nothing to change');
    await tx({ userId: req.user.id, reason: 'Edit staff profile' }, async (c) => {
      const r = await c.query(`UPDATE technicians SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`, vals);
      if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Staff member not found');
    });
    res.json({ ok: true });
  });

  app.post('/staff/:id/absences', ...secure('staff.manage'), async (req, res) => {
    const id = int(req.params.id, 'staff member'), b = req.body || {}, date = String(b.date || '');
    if (!dateOk(date) || date > today()) throw bad('Choose a valid date that is not in the future');
    if (!ABSENCE_KINDS[b.kind]) throw bad('Choose the type of absence');
    const reason = String(b.reason ?? '').trim().slice(0, 300) || null;
    const out = await tx({ userId: req.user.id, reason: 'Record staff absence' }, async (c) => {
      const t = await c.query('SELECT 1 FROM technicians WHERE id = $1', [id]); if (!t.rowCount) throw new AppError(404, 'NOT_FOUND', 'Staff member not found');
      const dup = await c.query('SELECT 1 FROM staff_absences WHERE technician_id = $1 AND absent_on = $2::date', [id, date]);
      if (dup.rowCount) throw new AppError(409, 'ALREADY_RECORDED', 'An absence is already recorded for that day');
      const r = await c.query(`INSERT INTO staff_absences (technician_id, absent_on, kind, reason, recorded_by) VALUES ($1,$2::date,$3,$4,$5) RETURNING id`, [id, date, b.kind, reason, req.user.id]);
      return { id: Number(r.rows[0].id) };
    });
    res.status(201).json(out);
  });
  app.delete('/staff/:id/absences/:absenceId', ...secure('staff.manage'), async (req, res) => {
    const id = int(req.params.id, 'staff member'), aid = int(req.params.absenceId, 'absence');
    await tx({ userId: req.user.id, reason: 'Remove staff absence' }, async (c) => {
      const r = await c.query('DELETE FROM staff_absences WHERE id = $1 AND technician_id = $2', [aid, id]);
      if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Absence not found');
    });
    res.json({ ok: true });
  });
}
