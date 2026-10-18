// Back-office screens: inventory, expenses, customers, appointments.
import { AppError } from '../errors.js';
import { moveStock } from '../sales/checkout.js';
import { loadBusiness, checkOpeningHours } from './settings.js';

export const EXPENSE_CATEGORIES = ['rent', 'utilities', 'salaries', 'commissions', 'marketing', 'supplies', 'repairs', 'cleaning', 'internet', 'other'];
export const APPT_STATUSES = ['booked', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show', 'rescheduled'];
const TZ = 'Africa/Nairobi';

export function registerOfficeRoutes(app, { db, tx, auth, secure, requireAny, requireBranch, branchList, v }) {
  const { int, text, money, oneOf, range } = v;
  const checkBirthday = (x) => {
    const t = x == null ? '' : String(x).trim(); if (!t) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t)) || t < '1900-01-01' || t > new Date().toISOString().slice(0, 10)) throw new AppError(422, 'BAD_BIRTHDAY', 'Birthday must be a valid date in the past');
    return t;
  };
  const opt = (x) => (x == null || String(x).trim() === '' ? null : String(x).trim());
  const oneBranch = (req, given) => { const b = branchList(req.user, given ?? req.query.branchId); if (!b || b.length !== 1) throw new AppError(422, 'BRANCH_REQUIRED', 'Choose a branch'); return b[0]; };
  const dupGuard = (e, code, message) => { if (e?.code === '23505') throw new AppError(409, code, message); throw e; };

  // ================= INVENTORY =================
  app.get('/products', ...secure('inventory.view'), async (req, res) => {
    const branch = oneBranch(req), showValue = req.user.permissions.has('inventory.valuation');
    const r = await db.query(
      `SELECT p.id, p.sku, p.name, p.unit, pc.name AS category, p.purchase_cost, COALESCE(i.qty_on_hand,0) AS on_hand, COALESCE(i.avg_unit_cost,0) AS avg_cost, COALESCE(i.min_level,0) AS min_level
         FROM products p LEFT JOIN product_categories pc ON pc.id = p.category_id LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = $1
        WHERE p.is_active ORDER BY p.name`, [branch]);
    const cats = await db.query('SELECT code, name FROM product_categories ORDER BY name');
    res.json({ categories: cats.rows, canManage: req.user.permissions.has('inventory.manage'), showValue,
      rows: r.rows.map((x) => { const cost = Number(x.avg_cost) > 0 ? Number(x.avg_cost) : Number(x.purchase_cost);
        return { id: Number(x.id), sku: x.sku, name: x.name, unit: x.unit, category: x.category, onHand: Number(x.on_hand), minLevel: Number(x.min_level), unitCost: cost,
          value: showValue ? Math.round(Number(x.on_hand) * cost * 100) / 100 : null, low: Number(x.min_level) > 0 && Number(x.on_hand) <= Number(x.min_level) }; }) });
  });
  app.post('/products', ...secure('inventory.manage'), async (req, res) => {
    const b = req.body || {}, branch = oneBranch(req, b.branchId), name = text(b.name, 'Item name'), cost = money(b.purchaseCost ?? 0, 'Unit cost'), min = money(b.minLevel ?? 0, 'Minimum level');
    const opening = b.openingQty == null || b.openingQty === '' ? 0 : money(b.openingQty, 'Opening quantity');
    const base = (String(b.sku || '').trim() || name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'ITEM';
    const out = await tx({ userId: req.user.id, reason: 'New stock item' }, async (c) => {
      let sku = base, n = 1;
      while ((await c.query('SELECT 1 FROM products WHERE sku = $1', [sku])).rowCount) sku = `${base}-${++n}`;
      const cat = b.categoryCode ? await c.query('SELECT id FROM product_categories WHERE code = $1', [String(b.categoryCode)]) : { rows: [] };
      const p = await c.query(`INSERT INTO products (sku, name, category_id, unit, purchase_cost) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [sku, name, cat.rows[0]?.id ?? null, opt(b.unit) || 'piece', cost]);
      const id = Number(p.rows[0].id);
      await c.query(`INSERT INTO inventory (product_id, branch_id, min_level) VALUES ($1,$2,$3) ON CONFLICT (product_id, branch_id) DO UPDATE SET min_level = EXCLUDED.min_level`, [id, branch, min]);
      if (opening > 0) await moveStock(c, { productId: id, branchId: branch, qty: opening, type: 'purchase', unitCost: cost, reason: 'Opening stock', refType: 'manual', refId: null, userId: req.user.id, allowNegative: true });
      return { id, sku };
    });
    res.status(201).json(out);
  });
  app.put('/products/:id', ...secure('inventory.manage'), async (req, res) => {
    const id = int(req.params.id, 'item'), b = req.body || {}, branch = oneBranch(req, b.branchId);
    await tx({ userId: req.user.id, reason: 'Edit stock item' }, async (c) => {
      const r = await c.query(`UPDATE products SET name = COALESCE($2, name), unit = COALESCE($3, unit), purchase_cost = COALESCE($4, purchase_cost), updated_at = now() WHERE id = $1 RETURNING id`,
        [id, opt(b.name), opt(b.unit), b.purchaseCost == null || b.purchaseCost === '' ? null : money(b.purchaseCost, 'Unit cost')]);
      if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Item not found');
      if (b.minLevel != null && b.minLevel !== '') await c.query(`INSERT INTO inventory (product_id, branch_id, min_level) VALUES ($1,$2,$3) ON CONFLICT (product_id, branch_id) DO UPDATE SET min_level = EXCLUDED.min_level`, [id, branch, money(b.minLevel, 'Minimum level')]);
    });
    res.json({ ok: true });
  });
  app.get('/inventory/movements', ...secure('inventory.view'), async (req, res) => {
    const branch = oneBranch(req), pid = int(req.query.productId, 'item');
    const r = await db.query(`SELECT it.created_at, it.txn_type, it.qty_change, it.unit_cost, it.reason, u.full_name AS by FROM inventory_transactions it LEFT JOIN users u ON u.id = it.created_by
                               WHERE it.product_id = $1 AND it.branch_id = $2 ORDER BY it.id DESC LIMIT 30`, [pid, branch]);
    res.json({ rows: r.rows.map((x) => ({ at: x.created_at, type: x.txn_type, qty: Number(x.qty_change), unitCost: x.unit_cost == null ? null : Number(x.unit_cost), reason: x.reason, by: x.by })) });
  });

  // ================= EXPENSES =================
  app.get('/expenses', ...secure('expenses.view'), async (req, res) => {
    const { from, to } = range(req.query), br = branchList(req.user, req.query.branchId);
    const r = await db.query(`SELECT e.id, e.expense_date::text AS date, e.category, e.amount, e.description, e.reference, u.full_name AS by FROM expenses e LEFT JOIN users u ON u.id = e.created_by
                               WHERE e.expense_date BETWEEN $1 AND $2 AND ($3::bigint[] IS NULL OR e.branch_id = ANY($3)) ORDER BY e.expense_date DESC, e.id DESC LIMIT 500`, [from, to, br]);
    const rows = r.rows.map((x) => ({ id: Number(x.id), date: x.date, category: x.category, amount: Number(x.amount), description: x.description || '', reference: x.reference || '', by: x.by }));
    const byCategory = {}; for (const x of rows) byCategory[x.category] = (byCategory[x.category] || 0) + x.amount;
    res.json({ from, to, categories: EXPENSE_CATEGORIES, canManage: req.user.permissions.has('expenses.manage'), total: rows.reduce((a, x) => a + x.amount, 0), byCategory, rows });
  });
  app.post('/expenses', ...secure('expenses.manage'), async (req, res) => {
    const b = req.body || {}, branch = oneBranch(req, b.branchId), category = oneOf(b.category, EXPENSE_CATEGORIES, 'category'), amount = money(b.amount, 'Amount');
    if (!(amount > 0)) throw new AppError(422, 'BAD_AMOUNT', 'Amount must be more than 0');
    const date = v.date(b.date, 'date');
    const out = await tx({ userId: req.user.id, reason: 'Record expense' }, (c) => c.query(
      `INSERT INTO expenses (branch_id, category, amount, expense_date, description, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [branch, category, amount, date, opt(b.description)?.slice(0, 300) ?? null, opt(b.reference)?.slice(0, 100) ?? null, req.user.id]));
    res.status(201).json({ id: Number(out.rows[0].id) });
  });
  app.delete('/expenses/:id', ...secure('expenses.manage'), async (req, res) => {
    const reason = text(req.query.reason, 'A reason');
    await tx({ userId: req.user.id, reason }, async (c) => {
      const r = await c.query('DELETE FROM expenses WHERE id = $1 AND ($2::bigint[] IS NULL OR branch_id = ANY($2)) RETURNING id', [int(req.params.id, 'expense'), branchList(req.user)]);
      if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Expense not found');
    });
    res.json({ ok: true });
  });

  // ================= CUSTOMERS =================
  const custView = [auth, requireAny('customers.view', 'customers.manage')];
  app.get('/customer-list', ...custView, async (req, res) => {
    const q = String(req.query.q || '').trim(), digits = q.replace(/\D/g, ''), status = opt(req.query.status);
    const r = await db.query(
      `SELECT customer_id, full_name, phone, visits, total_spend, avg_spend_per_visit, last_visit::text AS last_visit, expected_next_visit::text AS next_visit, status, marketing_consent, days_since_last_visit
         FROM v_customer_metrics WHERE ($1 = '' OR full_name ILIKE '%' || $1 || '%' OR ($2 <> '' AND regexp_replace(COALESCE(phone,''), '\\D', '', 'g') LIKE '%' || $2 || '%'))
          AND ($3::text IS NULL OR status = $3) ORDER BY (last_visit IS NULL), last_visit DESC, full_name LIMIT 500`, [q.replace(/[%_\\]/g, ''), digits, status]);
    res.json({ rows: r.rows.map((x) => ({ id: Number(x.customer_id), name: x.full_name, phone: x.phone, visits: Number(x.visits), spend: Number(x.total_spend), avgSpend: x.avg_spend_per_visit == null ? null : Number(x.avg_spend_per_visit),
      lastVisit: x.last_visit, nextVisit: x.next_visit, status: x.status, consent: !!x.marketing_consent, daysSince: x.days_since_last_visit == null ? null : Number(x.days_since_last_visit) })) });
  });
  app.get('/customers/:id', ...custView, async (req, res) => {
    const id = int(req.params.id, 'customer');
    const m = await db.query(`SELECT * FROM v_customer_metrics WHERE customer_id = $1`, [id]);
    if (!m.rowCount) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
    const x = m.rows[0];
    const [visits, topSvc, topTech, notes, extra] = await Promise.all([
      db.query(`SELECT t.business_date::text AS date, t.receipt_no, t.total, (SELECT string_agg(ti.description, ', ' ORDER BY ti.line_no) FROM transaction_items ti WHERE ti.transaction_id = t.id) AS services
                  FROM transactions t WHERE t.customer_id = $1 AND t.status <> 'voided' ORDER BY t.business_date DESC, t.id DESC LIMIT 30`, [id]),
      db.query(`SELECT ti.description AS name, COUNT(*) AS n FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id AND t.status <> 'voided' WHERE t.customer_id = $1 AND ti.item_type = 'service' GROUP BY ti.description ORDER BY n DESC, ti.description LIMIT 1`, [id]),
      db.query(`SELECT tech.display_name AS name, COUNT(*) AS n FROM v_item_credits cr JOIN transactions t ON t.id = cr.transaction_id AND t.status <> 'voided' JOIN technicians tech ON tech.id = cr.technician_id WHERE t.customer_id = $1 GROUP BY tech.display_name ORDER BY n DESC, tech.display_name LIMIT 1`, [id]),
      db.query(`SELECT n.note, n.created_at, u.full_name AS by FROM customer_notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.customer_id = $1 ORDER BY n.id DESC LIMIT 30`, [id]),
      db.query(`SELECT allergies, birthday::text AS birthday FROM customers WHERE id = $1`, [id]),
    ]);
    res.json({ id, name: x.full_name, phone: x.phone, status: x.status, consent: !!x.marketing_consent, birthday: extra.rows[0]?.birthday ?? null, allergies: extra.rows[0]?.allergies ?? '',
      visits: Number(x.visits), spend: Number(x.total_spend), avgSpend: x.avg_spend_per_visit == null ? null : Number(x.avg_spend_per_visit), servicesBought: Number(x.services_purchased),
      daysSince: x.days_since_last_visit == null ? null : Number(x.days_since_last_visit), avgDaysBetween: x.avg_days_between == null ? null : Math.round(Number(x.avg_days_between)),
      lastVisit: x.last_visit, nextVisit: x.expected_next_visit, topService: topSvc.rows[0]?.name ?? null, preferredTechnician: topTech.rows[0]?.name ?? null,
      canManage: req.user.permissions.has('customers.manage'),
      history: visits.rows.map((r) => ({ date: r.date, receipt: r.receipt_no, services: r.services, total: Number(r.total) })),
      notes: notes.rows.map((r) => ({ note: r.note, at: r.created_at, by: r.by })) });
  });
  app.post('/customers', ...secure('customers.manage'), async (req, res) => {
    const b = req.body || {}, name = text(b.fullName, 'Name'), phone = opt(b.phone), birthday = checkBirthday(b.birthday);
    const out = await tx({ userId: req.user.id, reason: 'Register customer' }, async (c) => {
      if (phone) { const d = await c.query('SELECT id FROM customers WHERE phone_normalized = normalize_ke_phone($1) AND deleted_at IS NULL', [phone]);
        if (d.rowCount) throw new AppError(409, 'PHONE_TAKEN', 'A customer with this phone number already exists'); }
      const consent = !!b.consent;
      const r = await c.query(`INSERT INTO customers (full_name, phone, whatsapp_number, marketing_consent, whatsapp_consent, sms_consent, consent_updated_at, registered_branch_id, birthday) VALUES ($1,$2,$2,$3,$3,$3,now(),$4,$5::date) RETURNING id`,
        [name, phone, consent, req.user.branchIds[0] ?? null, birthday]);
      return { id: Number(r.rows[0].id) };
    });
    res.status(201).json(out);
  });
  app.put('/customers/:id', ...secure('customers.manage'), async (req, res) => {
    const id = int(req.params.id, 'customer'), b = req.body || {};
    try {
      await tx({ userId: req.user.id, reason: 'Edit customer' }, async (c) => {
        const r = await c.query(
          `UPDATE customers SET full_name = COALESCE($2, full_name), phone = COALESCE($3, phone), whatsapp_number = COALESCE($3, whatsapp_number), allergies = COALESCE($4, allergies),
                  birthday = COALESCE($5::date, birthday),
                  marketing_consent = COALESCE($6::boolean, marketing_consent), whatsapp_consent = COALESCE($6::boolean, whatsapp_consent), sms_consent = COALESCE($6::boolean, sms_consent),
                  consent_updated_at = CASE WHEN $6::boolean IS NULL THEN consent_updated_at ELSE now() END, updated_at = now()
            WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
          [id, opt(b.fullName), opt(b.phone), b.allergies == null ? null : String(b.allergies).slice(0, 500), checkBirthday(b.birthday), b.consent == null ? null : !!b.consent]);
        if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
      });
    } catch (e) { dupGuard(e, 'PHONE_TAKEN', 'Another customer already has this phone number'); }
    res.json({ ok: true });
  });
  app.post('/customers/:id/notes', ...secure('customers.manage'), async (req, res) => {
    const id = int(req.params.id, 'customer'), note = text(req.body?.note, 'A note');
    await tx({ userId: req.user.id, reason: 'Customer note' }, (c) => c.query('INSERT INTO customer_notes (customer_id, note, created_by) VALUES ($1,$2,$3)', [id, note, req.user.id]));
    res.status(201).json({ ok: true });
  });

  // ================= APPOINTMENTS =================
  app.get('/appointments', ...[auth, requireAny('appointments.view', 'appointments.view_own')], async (req, res) => {
    const { from, to } = range(req.query), br = branchList(req.user, req.query.branchId);
    const own = req.user.permissions.has('appointments.view') ? null : req.user.technicianId;
    if (!req.user.permissions.has('appointments.view') && !own) throw new AppError(403, 'FORBIDDEN', 'No technician profile linked to this login');
    const r = await db.query(
      `SELECT a.id, a.starts_at, a.expected_duration_minutes AS minutes, a.status, a.notes, a.deposit_amount, a.customer_id, c.full_name AS customer, c.phone, a.technician_id, tech.display_name AS technician,
              COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name) FROM appointment_services x JOIN services s ON s.id = x.service_id WHERE x.appointment_id = a.id), '[]'::json) AS services
         FROM appointments a JOIN customers c ON c.id = a.customer_id LEFT JOIN technicians tech ON tech.id = a.technician_id
        WHERE (a.starts_at AT TIME ZONE '${TZ}')::date BETWEEN $1 AND $2 AND ($3::bigint[] IS NULL OR a.branch_id = ANY($3)) AND ($4::bigint IS NULL OR a.technician_id = $4)
        ORDER BY a.starts_at`, [from, to, br, own]);
    res.json({ from, to, statuses: APPT_STATUSES, canManage: req.user.permissions.has('appointments.manage'),
      rows: r.rows.map((x) => ({ id: Number(x.id), startsAt: x.starts_at, minutes: x.minutes, status: x.status, notes: x.notes || '', deposit: Number(x.deposit_amount), customerId: Number(x.customer_id),
        customer: x.customer, phone: req.user.permissions.has('customers.view') ? x.phone : null, technicianId: x.technician_id == null ? null : Number(x.technician_id), technician: x.technician, services: x.services })) });
  });
  app.post('/appointments', ...secure('appointments.manage'), requireBranch((r) => r.body.branchId), async (req, res) => {
    const b = req.body || {}, branch = int(b.branchId, 'branch'), customerId = int(b.customerId, 'customer');
    const startsAt = new Date(b.startsAt); if (Number.isNaN(+startsAt)) throw new AppError(422, 'BAD_TIME', 'Choose a date and time');
    const serviceIds = [...new Set((b.serviceIds || []).map((x) => int(x, 'service')))];
    const techId = b.technicianId ? int(b.technicianId, 'technician') : null, deposit = b.deposit == null || b.deposit === '' ? 0 : money(b.deposit, 'Deposit');
    try {
      const out = await tx({ userId: req.user.id, reason: 'Book appointment' }, async (c) => {
        const sv = serviceIds.length ? await c.query('SELECT id, standard_price, duration_minutes FROM services WHERE id = ANY($1::bigint[]) AND is_active', [serviceIds]) : { rows: [] };
        if (sv.rows.length !== serviceIds.length) throw new AppError(422, 'UNKNOWN_SERVICE', 'One of the services is not available');
        const minutes = b.minutes ? int(b.minutes, 'minutes') : Math.max(15, sv.rows.reduce((a, x) => a + Number(x.duration_minutes), 0) || 60);
        let note = opt(b.notes)?.slice(0, 500) ?? null;
        if (b.overrideHours === true && req.user.permissions.has('settings.business')) {            // owner-only: book outside opening hours
          try { checkOpeningHours((await loadBusiness(c, branch)).hours, startsAt, minutes); }
          catch (e) { if (e?.code !== 'OUTSIDE_HOURS' && e?.code !== 'CLOSED') throw e; note = `[Booked outside opening hours by ${req.user.name}] ${note || ''}`.trim().slice(0, 500); }
        } else checkOpeningHours((await loadBusiness(c, branch)).hours, startsAt, minutes);
        const r = await c.query(`INSERT INTO appointments (branch_id, customer_id, technician_id, starts_at, expected_duration_minutes, source, notes, deposit_amount, payment_status, created_by)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [branch, customerId, techId, startsAt.toISOString(), minutes, oneOf(b.source || 'booking', ['booking', 'walk_in', 'whatsapp', 'phone', 'online'], 'source'), note, deposit, deposit > 0 ? 'deposit_paid' : 'unpaid', req.user.id]);
        for (const s of sv.rows) await c.query('INSERT INTO appointment_services (appointment_id, service_id, technician_id, duration_minutes, quoted_price) VALUES ($1,$2,$3,$4,$5)', [r.rows[0].id, s.id, techId, s.duration_minutes, s.standard_price]);
        return { id: Number(r.rows[0].id) };
      });
      res.status(201).json(out);
    } catch (e) { if (e?.code === '23P01') throw new AppError(409, 'DOUBLE_BOOKED', 'That technician is already booked at this time. Choose another time or technician.'); throw e; }
  });
  app.put('/appointments/:id/status', ...secure('appointments.manage'), async (req, res) => {
    const id = int(req.params.id, 'appointment'), status = oneOf(req.body?.status, APPT_STATUSES, 'status');
    await tx({ userId: req.user.id, reason: `Appointment ${status}` }, async (c) => {
      const r = await c.query(`UPDATE appointments SET status = $2, updated_at = now() WHERE id = $1 AND ($3::bigint[] IS NULL OR branch_id = ANY($3)) RETURNING id`, [id, status, branchList(req.user)]);
      if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Appointment not found');
    });
    res.json({ ok: true });
  });
}
