import { AppError } from '../errors.js';
import { login as loginSvc } from '../auth/service.js';
import { authMiddleware, requirePermission, requireBranch } from '../auth/http.js';
import { checkout as realCheckout, voidSale as realVoid, moveStock } from '../sales/checkout.js';
import { toCsv } from '../lib/csv.js';
import * as realImporter from '../import/run.js';
import { randomBytes } from 'node:crypto';
import { resolveRule } from '../commission/engine.js';
import fs from 'node:fs';
const PAGE_URL = new URL('../../public/index.html', import.meta.url);
let pageCache = null;
const page = () => (pageCache ??= fs.readFileSync(PAGE_URL, 'utf8'));
import { createUser } from '../auth/service.js';
import { registerOfficeRoutes } from './office.js';
import { registerSettingsRoutes, loadBusiness } from './settings.js';
import { registerStaffRoutes } from './staff.js';
import { registerGrowthRoutes, awardForSale, reverseForSale } from './growth.js';
import { hashPassword, verifyPassword } from '../auth/password.js';

const tempPassword = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; const b = randomBytes(8); return [...b].map((x) => a[x % a.length]).join('') + 'Z9'; };
const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');

// ---------- small validators ----------
const date = (v, name) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '') || Number.isNaN(Date.parse(v))) throw new AppError(422, 'BAD_DATE', `${name} must be a date like 2026-10-05`);
  return v;
};
const range = (q) => {
  const from = date(q.from, 'from'), to = date(q.to, 'to');
  if (from > to) throw new AppError(422, 'BAD_RANGE', '"from" must not be after "to"');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 366) throw new AppError(422, 'BAD_RANGE', 'Choose a range of at most one year');
  return { from, to };
};
const int = (v, name) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new AppError(422, 'BAD_' + name.toUpperCase(), `${name} is required`); return n; };
const text = (v, name) => { if (typeof v !== 'string' || !v.trim()) throw new AppError(422, 'REASON_REQUIRED', `${name} is required`); return v.trim().slice(0, 500); };
const money = (v, name) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new AppError(422, 'BAD_AMOUNT', `${name} must be a number of 0 or more`); return n; };
const oneOf = (v, list, name) => { if (!list.includes(v)) throw new AppError(422, 'BAD_' + name.toUpperCase(), `${name} must be one of ${list.join(', ')}`); return v; };

/** null = all branches (super admin); otherwise the list of branches this user may see. */
function branchList(user, requested) {
  const all = user.permissions.has('branches.manage');
  if (requested !== undefined && requested !== '') {
    const b = int(requested, 'branch');
    if (!all && !user.branchIds.includes(b)) throw new AppError(403, 'WRONG_BRANCH', 'You are not assigned to this branch');
    return [b];
  }
  return all ? null : user.branchIds;
}
/** Sales visibility: everyone with sales.view sees all technicians; others only their own. */
function techScope(user) {
  if (user.permissions.has('sales.view')) return null;
  if (user.permissions.has('sales.view_own') && user.technicianId) return user.technicianId;
  throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view sales');
}
const requireAny = (...perms) => (req, res, next) =>
  next(perms.some((p) => req.user?.permissions.has(p)) ? undefined : new AppError(req.user ? 403 : 401, req.user ? 'FORBIDDEN' : 'UNAUTHENTICATED', 'You do not have permission to do this'));
const attachment = (res, name, csv) => { res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send(csv, 'text/csv; charset=utf-8'); };

// Login throttle: 10 attempts per minute per IP+email.
function limiter(max = 10, windowMs = 60_000, now = () => Date.now()) {
  const hits = new Map();
  return (key) => { const t = now(), arr = (hits.get(key) || []).filter((x) => t - x < windowMs); arr.push(t); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
    if (arr.length > max) throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Wait a minute and try again.'); };
}

export function registerRoutes(app, { db, tx, secret, deps = {}, now }) {
  const checkout = deps.checkout || realCheckout, voidSale = deps.voidSale || realVoid, importer = deps.importer || realImporter;
  const throttle = limiter(10, 60_000, now);
  const auth = authMiddleware({ db, secret });
  const secure = (...perms) => [auth, ...(perms.length ? [requirePermission(...perms)] : [])];

  app.get('/health', (req, res) => res.json({ ok: true }));

  // ---------- auth ----------
  app.post('/auth/login', async (req, res) => {
    const { email, password, otp } = req.body || {};
    throttle(`${req.socket?.remoteAddress}|${String(email).toLowerCase()}`);
    res.json(await loginSvc(db, { email, password, otp }, { secret }));
  });
  app.get('/me', ...secure(), async (req, res) => {
    const all = req.user.permissions.has('branches.manage');
    // ONLY_BRANCH_CODE (optional): a separate installation that serves one branch shows no branch switcher.
    const only = (process.env.ONLY_BRANCH_CODE || '').trim() || null;
    const b = await db.query(`SELECT id, name FROM branches WHERE is_active AND ($1::boolean OR id = ANY($2::bigint[])) AND ($3::text IS NULL OR code = $3) ORDER BY id`, [all, req.user.branchIds, only]);
    const ids = b.rows.map((x) => Number(x.id));
    res.json({ id: req.user.id, name: req.user.name, role: req.user.role, permissions: [...req.user.permissions].sort(), branchIds: only ? req.user.branchIds.filter((i) => ids.includes(i)) : req.user.branchIds, technicianId: req.user.technicianId,
      branches: b.rows.map((x) => ({ id: Number(x.id), name: x.name })) });
  });
  // The web screen (one HTML file) is served by the same app, so no extra hosting or CORS setup is needed.
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.get('/', (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    res.send(page(), 'text/html; charset=utf-8');
  });

  // ---------- sales ----------
  app.post('/sales', ...secure('sales.create', 'payments.process'), requireBranch((r) => r.body.branchId), async (req, res) => {
    const b = { ...req.body };
    if (b.discounts?.length && !req.user.permissions.has('discounts.apply')) throw new AppError(403, 'FORBIDDEN', 'You cannot apply discounts');
    if (b.businessDate && !req.user.permissions.has('data.import')) delete b.businessDate;     // only importers may back-date
    b.discountApprovedBy = req.user.permissions.has('discounts.approve') ? req.user.id : undefined;
    delete b.approvedBy;
    const out = await tx({ userId: req.user.id }, async (c) => {
      const r = await checkout(c, b, { userId: req.user.id });
      if (b.appointmentId) await c.query(`UPDATE appointments SET status = 'completed', updated_at = now() WHERE id = $1 AND status NOT IN ('cancelled','no_show')`, [Number(b.appointmentId)]);
      if (r?.transactionId) await awardForSale(c, r.transactionId);
      return r;
    });
    res.status(201).json(out);
  });
  app.post('/sales/:id/void', ...secure('sales.void'), async (req, res) => {
    const reason = text(req.body.reason, 'A reason');
    const out = await tx({ userId: req.user.id, reason }, async (c) => {
      const t = await c.query('SELECT branch_id FROM transactions WHERE id = $1', [int(req.params.id, 'sale')]);
      if (!t.rowCount) throw new AppError(404, 'NOT_FOUND', 'Sale not found');
      if (!req.user.permissions.has('branches.manage') && !req.user.branchIds.includes(Number(t.rows[0].branch_id)))
        throw new AppError(403, 'WRONG_BRANCH', 'You are not assigned to this branch');
      const vr = await voidSale(c, Number(req.params.id), { userId: req.user.id, reason });
      await reverseForSale(c, Number(req.params.id));
      return vr;
    });
    res.json(out);
  });
  app.get('/sales/:id/receipt', ...secure('receipts.view'), async (req, res) => {
    const id = int(req.params.id, 'sale');
    const t = await db.query(
      `SELECT t.id, t.receipt_no, t.branch_id, b.name AS branch, t.occurred_at, t.subtotal, t.discount_total, t.total, t.amount_paid, t.balance, t.status,
              c.full_name AS customer, c.phone, t.notes
         FROM transactions t JOIN branches b ON b.id = t.branch_id JOIN customers c ON c.id = t.customer_id WHERE t.id = $1`, [id]);
    if (!t.rowCount) throw new AppError(404, 'NOT_FOUND', 'Sale not found');
    if (!req.user.permissions.has('branches.manage') && !req.user.branchIds.includes(Number(t.rows[0].branch_id)))
      throw new AppError(403, 'WRONG_BRANCH', 'You are not assigned to this branch');
    const items = await db.query(
      `SELECT ti.description, CASE WHEN ti.collab_technician_id IS NULL THEN tech.display_name ELSE tech.display_name || ' + ' || ct.display_name END AS technician, ti.quantity, ti.net_amount FROM transaction_items ti
         LEFT JOIN technicians tech ON tech.id = ti.technician_id LEFT JOIN technicians ct ON ct.id = ti.collab_technician_id WHERE ti.transaction_id = $1 ORDER BY ti.line_no`, [id]);
    const pays = await db.query('SELECT method, amount, reference FROM payments WHERE transaction_id = $1 ORDER BY id', [id]);
    const biz = await loadBusiness(db, t.rows[0].branch_id);
    res.json({ business: biz.name, businessInfo: { name: biz.name, tagline: biz.tagline, phone: biz.phone, email: biz.email, address: biz.address, taxPin: biz.taxPin, logo: biz.logo }, ...t.rows[0], items: items.rows, payments: pays.rows, footer: biz.receiptFooter });
  });

  // ---------- reports ----------
  const ccPer = `(SELECT transaction_item_id, technician_id, SUM(commission_amount) AS amt, SUM(material_cost) FILTER (WHERE reverses_id IS NULL) AS mat FROM commission_calculations GROUP BY transaction_item_id, technician_id)`;
  const dailySql = `SELECT tn.id AS transaction_id, tn.receipt_no, tn.business_date::text AS date, tech.display_name AS technician_name,
            cr.description || CASE WHEN cr.is_collab THEN ' (collabo)' ELSE '' END AS service, cr.amount,
            (SELECT string_agg(m, ' + ' ORDER BY m) FROM (SELECT DISTINCT CASE p.method WHEN 'mpesa' THEN 'M-Pesa' ELSE initcap(p.method) END AS m
                  FROM payments p WHERE p.transaction_id = tn.id AND p.amount > 0) x) AS payment_modes,
            c.full_name AS customer_name, c.phone AS contact, tn.notes,
            COALESCE(cc.mat, CASE WHEN cr.is_collab THEN 0 ELSE ti.material_cost END, 0) AS material_cost, COALESCE(cc.amt, 0) AS commission
      FROM v_item_credits cr JOIN transactions tn ON tn.id = cr.transaction_id AND tn.status <> 'voided'
      JOIN transaction_items ti ON ti.id = cr.item_id JOIN technicians tech ON tech.id = cr.technician_id JOIN customers c ON c.id = tn.customer_id
      LEFT JOIN ${ccPer} cc ON cc.transaction_item_id = cr.item_id AND cc.technician_id = cr.technician_id
     WHERE tn.business_date BETWEEN $1 AND $2 AND ($3::bigint[] IS NULL OR tn.branch_id = ANY($3))
       AND ($4::bigint IS NULL OR cr.technician_id = $4) ORDER BY tn.business_date, tn.receipt_no, cr.item_id, cr.is_collab`;
  const weeklySql = `SELECT tech.display_name AS technician_name, COUNT(DISTINCT t.customer_id)::int AS customers_served,
         SUM(cr.amount) AS total_sales, COALESCE(SUM(cc.amt), 0) AS commission
      FROM v_item_credits cr JOIN transactions t ON t.id = cr.transaction_id AND t.status <> 'voided'
      JOIN technicians tech ON tech.id = cr.technician_id
      LEFT JOIN ${ccPer} cc ON cc.transaction_item_id = cr.item_id AND cc.technician_id = cr.technician_id
     WHERE t.business_date BETWEEN $1 AND $2 AND ($3::bigint[] IS NULL OR t.branch_id = ANY($3))
       AND ($4::bigint IS NULL OR cr.technician_id = $4)
     GROUP BY tech.display_name ORDER BY SUM(cr.amount) DESC`;
  const uniqueSql = `SELECT COUNT(DISTINCT t.customer_id)::int AS n FROM transactions t
     WHERE t.status <> 'voided' AND t.business_date BETWEEN $1 AND $2 AND ($3::bigint[] IS NULL OR t.branch_id = ANY($3))
       AND ($4::bigint IS NULL OR EXISTS (SELECT 1 FROM v_item_credits cr WHERE cr.transaction_id = t.id AND cr.technician_id = $4))`;
  const canSeeContact = (u) => u.permissions.has('customers.view');
  const reportAuth = [auth, requireAny('sales.view', 'sales.view_own')];
  const csvAuth = (req) => { if (!req.user.permissions.has('data.export')) throw new AppError(403, 'FORBIDDEN', 'You cannot export data'); };

  app.get('/reports/daily-sales', ...reportAuth, async (req, res) => {
    const { from, to } = range(req.query), br = branchList(req.user, req.query.branchId), tech = techScope(req.user);
    const r = await db.query(dailySql, [from, to, br, tech]);
    const rows = r.rows.map((x) => ({ transactionId: x.transaction_id == null ? null : Number(x.transaction_id), receiptNo: x.receipt_no, date: x.date, technician: x.technician_name, service: x.service, amount: Number(x.amount),
      paymentMode: x.payment_modes, customer: x.customer_name, contact: canSeeContact(req.user) ? x.contact : null, notes: x.notes || '',
      materials: Number(x.material_cost), commission: Number(x.commission) }));
    if (req.query.format === 'csv') {
      csvAuth(req);
      return attachment(res, `daily-sales-${from}_to_${to}.csv`, toCsv(['DATE', 'TECHNICIAN NAME', 'SERVICE', 'AMOUNT', 'MODE OF PAYMENT', 'CUSTOMER NAME', 'CONTACT', 'MATERIALS COST', 'COMMISSION'],
        rows.map((x) => [x.date, x.technician, x.service, x.amount, x.paymentMode, x.customer, x.contact, x.materials, x.commission])));
    }
    res.json({ from, to, total: rows.reduce((a, x) => a + x.amount, 0), totalMaterials: rows.reduce((a, x) => a + x.materials, 0),
      totalCommission: rows.reduce((a, x) => a + x.commission, 0), rows });
  });
  app.get('/reports/weekly-sales', ...reportAuth, async (req, res) => {
    const { from, to } = range(req.query), br = branchList(req.user, req.query.branchId), tech = techScope(req.user);
    const r = await db.query(weeklySql, [from, to, br, tech]);
    const u = await db.query(uniqueSql, [from, to, br, tech]);
    const rows = r.rows.map((x) => ({ technician: x.technician_name, customersServed: x.customers_served,
      totalSales: Number(x.total_sales), commission: Number(x.commission) }));
    const total = { customersServed: u.rows[0]?.n ?? 0, totalSales: rows.reduce((a, x) => a + x.totalSales, 0), commission: rows.reduce((a, x) => a + x.commission, 0) };
    if (req.query.format === 'csv') {
      csvAuth(req);
      return attachment(res, `weekly-sales-${from}_to_${to}.csv`, toCsv(['TECHNICIAN NAME', 'NO OF CUSTOMERS SERVED', 'TOTAL SALES', 'COMMISSION'],
        [...rows.map((x) => [x.technician, x.customersServed, x.totalSales, x.commission]), ['TOTAL', total.customersServed, total.totalSales, total.commission]]));
    }
    res.json({ from, to, rows, total });
  });

  // ---------- dashboard ----------
  const weekStartOf = (iso) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7)); return d.toISOString().slice(0, 10); };
  const addIso = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const salesSql = `SELECT COALESCE(SUM(t.total),0) AS sales, COUNT(DISTINCT t.customer_id)::int AS customers,
         COUNT(DISTINCT t.customer_id) FILTER (WHERE vi.is_new_customer)::int AS new_customers,
         COALESCE(SUM(sv.services),0)::int AS services, COALESCE(SUM(sv.materials),0) AS materials
      FROM transactions t JOIN visits vi ON vi.id = t.visit_id
      LEFT JOIN (SELECT transaction_id, COUNT(*) FILTER (WHERE item_type = 'service') AS services,
                        SUM(material_cost) FILTER (WHERE item_type = 'service') AS materials FROM transaction_items GROUP BY transaction_id) sv ON sv.transaction_id = t.id
     WHERE t.status <> 'voided' AND t.business_date BETWEEN $1 AND $2 AND ($3::bigint[] IS NULL OR t.branch_id = ANY($3))`;
  const commSql = `SELECT COALESCE(SUM(commission_amount),0) AS commission FROM commission_calculations
     WHERE business_date BETWEEN $1 AND $2 AND ($3::bigint[] IS NULL OR branch_id = ANY($3))`;
  app.get('/dashboard', ...secure('dashboard.view'), async (req, res) => {
    const { from, to } = range(req.query), br = branchList(req.user, req.query.branchId);
    const today = (await db.query('SELECT business_today()::text AS d')).rows[0]?.d;
    const wk = weekStartOf(today), lastWk = addIso(wk, -7);
    const num = (r, k) => Number(r.rows[0]?.[k] ?? 0);
    const [cur, comm, exp, week, lastWeek, day, liab, tech, low] = await Promise.all([
      db.query(salesSql, [from, to, br]), db.query(commSql, [from, to, br]),
      db.query(`SELECT COALESCE(SUM(amount),0) AS expenses FROM expenses WHERE expense_date BETWEEN $1 AND $2 AND ($3::bigint[] IS NULL OR branch_id = ANY($3))`, [from, to, br]),
      db.query(salesSql, [wk, addIso(wk, 6), br]), db.query(salesSql, [lastWk, addIso(lastWk, 6), br]), db.query(salesSql, [today, today, br]),
      db.query(`SELECT COALESCE(SUM(commission_amount) FILTER (WHERE status = 'pending'),0) AS pending, COALESCE(SUM(commission_amount) FILTER (WHERE status = 'approved'),0) AS approved,
                       COUNT(*) FILTER (WHERE status = 'pending' AND reverses_id IS NULL)::int AS pending_lines
                  FROM commission_calculations WHERE status <> 'paid' AND ($1::bigint[] IS NULL OR branch_id = ANY($1))`, [br]),
      db.query(`SELECT tech.display_name AS technician, COUNT(*)::int AS services, SUM(cr.amount) AS revenue, COALESCE(SUM(cc.amt),0) AS commission
                  FROM v_item_credits cr JOIN transactions t ON t.id = cr.transaction_id AND t.status <> 'voided'
                  JOIN technicians tech ON tech.id = cr.technician_id
                  LEFT JOIN ${ccPer} cc ON cc.transaction_item_id = cr.item_id AND cc.technician_id = cr.technician_id
                 WHERE t.business_date BETWEEN $1 AND $2 AND ($3::bigint[] IS NULL OR t.branch_id = ANY($3))
                 GROUP BY tech.display_name ORDER BY SUM(cr.amount) DESC`, [from, to, br]),
      db.query(`SELECT p.name, i.qty_on_hand FROM inventory i JOIN products p ON p.id = i.product_id
                 WHERE i.min_level > 0 AND i.qty_on_hand <= i.min_level AND ($1::bigint[] IS NULL OR i.branch_id = ANY($1)) ORDER BY p.name LIMIT 20`, [br]),
    ]);
    let inventoryValue = null;
    if (req.user.permissions.has('inventory.valuation')) {
      const iv = await db.query(`SELECT COALESCE(SUM(qty_on_hand * avg_unit_cost),0) AS v FROM inventory WHERE ($1::bigint[] IS NULL OR branch_id = ANY($1))`, [br]);
      inventoryValue = num(iv, 'v');
    }
    const tg = await db.query(`SELECT (value #>> '{}')::numeric AS v FROM app_settings WHERE branch_id IS NULL AND key = 'target.weekly_sales'`);
    const sales = num(cur, 'sales'), customers = num(cur, 'customers'), services = num(cur, 'services'), materials = num(cur, 'materials'), commission = num(comm, 'commission'), expenses = num(exp, 'expenses');
    const target = tg.rows[0]?.v == null ? null : Number(tg.rows[0].v);
    res.json({ from, to, today, weekStart: wk,
      kpi: { sales, customers, services, avgSpend: customers ? sales / customers : 0, servicesPerCustomer: customers ? services / customers : 0,
        newCustomers: num(cur, 'new_customers'), returningCustomers: customers - num(cur, 'new_customers'), materials, commission, expenses,
        profit: sales - materials - commission - expenses, commissionOwed: num(liab, 'pending') + num(liab, 'approved'), inventoryValue },
      target: { weeklySales: target, thisWeek: num(week, 'sales'), lastWeek: num(lastWeek, 'sales'), canSet: req.user.permissions.has('targets.manage') },
      today: { sales: num(day, 'sales'), customers: num(day, 'customers'), services: num(day, 'services') },
      alerts: { lowStock: low.rows.map((x) => ({ name: x.name, onHand: Number(x.qty_on_hand) })), commissionsPending: liab.rows[0]?.pending_lines ?? 0 },
      technicians: tech.rows.map((x) => ({ technician: x.technician, services: x.services, revenue: Number(x.revenue), commission: Number(x.commission) })) });
  });
  app.put('/targets/weekly', ...secure('targets.manage'), async (req, res) => {
    const v = money(req.body.salesTarget, 'salesTarget');
    await tx({ userId: req.user.id, reason: 'Set weekly sales target' }, (c) => c.query(
      `INSERT INTO app_settings (branch_id, key, value, updated_by) VALUES (NULL, 'target.weekly_sales', to_jsonb($1::numeric), $2)
       ON CONFLICT (COALESCE(branch_id, 0), key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [v, req.user.id]));
    res.json({ weeklySales: v });
  });

  // ---------- commissions ----------
  app.get('/commissions/summary', ...[auth, requireAny('commissions.view_all', 'commissions.view_own')], async (req, res) => {
    const { from, to } = range(req.query), br = branchList(req.user, req.query.branchId);
    const own = req.user.permissions.has('commissions.view_all') ? null : req.user.technicianId;
    if (!req.user.permissions.has('commissions.view_all') && !own) throw new AppError(403, 'FORBIDDEN', 'No technician profile linked to this user');
    const r = await db.query(
      `SELECT t.display_name AS technician, t.phone, cc.technician_id, t.specialty_category_id,
              COALESCE(SUM(cc.commission_amount),0) AS total,
              COALESCE(SUM(cc.commission_amount) FILTER (WHERE cc.status='pending'),0) AS pending,
              COALESCE(SUM(cc.commission_amount) FILTER (WHERE cc.status='approved'),0) AS approved,
              COALESCE(SUM(cc.commission_amount) FILTER (WHERE cc.status='paid'),0) AS paid
         FROM commission_calculations cc JOIN technicians t ON t.id = cc.technician_id
        WHERE cc.business_date BETWEEN $1 AND $2 AND ($3::bigint[] IS NULL OR cc.branch_id = ANY($3)) AND ($4::bigint IS NULL OR cc.technician_id = $4)
        GROUP BY t.display_name, t.phone, cc.technician_id, t.specialty_category_id ORDER BY t.display_name`, [from, to, br, own]);
    const rows = r.rows.map((x) => ({ technicianId: Number(x.technician_id), technician: x.technician, phone: x.phone || null, total: Number(x.total),
      pending: Number(x.pending), approved: Number(x.approved), paid: Number(x.paid) }));
    res.json({ from, to, rows });
  });
  app.post('/commissions/approve', ...secure('commissions.approve'), async (req, res) => {
    const { from, to } = range(req.body), br = branchList(req.user, req.body.branchId);
    const out = await tx({ userId: req.user.id, reason: `Approve commissions ${from} to ${to}` }, async (c) => {
      const r = await c.query(
        `UPDATE commission_calculations SET status = 'approved', approved_by = $3, approved_at = now()
          WHERE status = 'pending' AND business_date BETWEEN $1 AND $2 AND ($4::bigint[] IS NULL OR branch_id = ANY($4))
            AND ($5::bigint IS NULL OR technician_id = $5) RETURNING commission_amount`,
        [from, to, req.user.id, br, req.body.technicianId ? int(req.body.technicianId, 'technician') : null]);
      return { approvedLines: r.rowCount, amount: r.rows.reduce((a, x) => a + Number(x.commission_amount), 0) };
    });
    res.json(out);
  });
  app.post('/commissions/pay', ...secure('commissions.pay'), async (req, res) => {
    const { from, to } = range(req.body), br = branchList(req.user, req.body.branchId), techId = int(req.body.technicianId, 'technician');
    const method = oneOf(req.body.method, ['mpesa', 'cash', 'bank', 'other'], 'method');
    const out = await tx({ userId: req.user.id, reason: `Pay commissions ${from} to ${to}` }, async (c) => {
      const rows = await c.query(
        `SELECT id, commission_amount, branch_id FROM commission_calculations
          WHERE status = 'approved' AND technician_id = $1 AND business_date BETWEEN $2 AND $3 AND ($4::bigint[] IS NULL OR branch_id = ANY($4)) FOR UPDATE`,
        [techId, from, to, br]);
      const total = rows.rows.reduce((a, x) => a + Math.round(Number(x.commission_amount) * 100), 0) / 100;
      if (!rows.rowCount || total <= 0) throw new AppError(422, 'NOTHING_TO_PAY', 'There are no approved commissions to pay for this technician and period');
      const p = await c.query(
        `INSERT INTO commission_payments (technician_id, branch_id, period_start, period_end, total_amount, method, reference, notes, paid_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [techId, br && br.length === 1 ? br[0] : null, from, to, total.toFixed(2), method, req.body.reference ?? null, req.body.notes ?? null, req.user.id]);
      await c.query(`UPDATE commission_calculations SET status = 'paid', paid_at = now(), commission_payment_id = $1 WHERE id = ANY($2::bigint[])`,
        [p.rows[0].id, rows.rows.map((x) => x.id)]);
      return { paymentId: Number(p.rows[0].id), lines: rows.rowCount, amount: total };
    });
    res.status(201).json(out);
  });

  // Line-by-line commission detail, used for the payslip and the CSV exports. status: all | pending | approved | paid
  const commissionLines = async (req, q) => {
    const { from, to } = range(q), br = branchList(req.user, q.branchId);
    const all = req.user.permissions.has('commissions.view_all');
    if (!all && !req.user.technicianId) throw new AppError(403, 'FORBIDDEN', 'No technician profile linked to this user');
    const tech = all ? (q.technicianId ? int(q.technicianId, 'technician') : null) : req.user.technicianId;
    const status = q.status ? oneOf(q.status, ['all', 'pending', 'approved', 'paid'], 'status') : 'all';
    const r = await db.query(
      `SELECT cc.id, cc.business_date::text AS date, t.receipt_no, ti.description AS service, tech.display_name AS technician, tech.specialty_category_id, b.name AS branch,
              cc.service_price, cc.material_cost, cc.commissionable_amount, cc.commission_rate::float8 AS rate, cc.calc_type, cc.commission_amount, cc.status,
              cc.approved_at::text AS approved_at, cc.paid_at::text AS paid_at, cp.method AS pay_method, cp.reference AS pay_reference, cc.reverses_id, cc.technician_id, (ti.collab_technician_id IS NOT NULL) AS collab
         FROM commission_calculations cc
         JOIN transactions t ON t.id = cc.transaction_id JOIN transaction_items ti ON ti.id = cc.transaction_item_id
         JOIN technicians tech ON tech.id = cc.technician_id JOIN branches b ON b.id = cc.branch_id
         LEFT JOIN commission_payments cp ON cp.id = cc.commission_payment_id
        WHERE cc.business_date BETWEEN $1 AND $2 AND ($3::bigint[] IS NULL OR cc.branch_id = ANY($3)) AND ($4::bigint IS NULL OR cc.technician_id = $4)
          AND ($5 = 'all' OR cc.status = $5)
        ORDER BY tech.display_name, cc.business_date, cc.id`, [from, to, br, tech, status]);
    return { from, to, status, rows: r.rows.map((x) => ({ date: x.date, receiptNo: x.receipt_no, service: x.service, technician: x.technician, technicianId: Number(x.technician_id), branch: x.branch,
      price: Number(x.service_price), materials: Number(x.material_cost), base: Number(x.commissionable_amount), rate: x.rate, calcType: x.calc_type, commission: Number(x.commission_amount),
      status: x.status, approvedAt: x.approved_at, paidAt: x.paid_at, payMethod: x.pay_method, payReference: x.pay_reference, reversal: x.reverses_id != null, collab: !!x.collab })) };
  };
  app.get('/commissions/lines', ...[auth, requireAny('commissions.view_all', 'commissions.view_own')], async (req, res) => {
    const d = await commissionLines(req, req.query);
    if (req.query.format === 'csv') {
      csvAuth(req);
      const label = d.status === 'all' ? 'all' : d.status;
      const pct = (x) => (x.rate == null ? '' : Math.round(x.rate * 10000) / 100 + '%');
      return attachment(res, `commissions-${label}-${d.from}_to_${d.to}.csv`, toCsv(
        ['DATE', 'RECEIPT', 'BRANCH', 'TECHNICIAN', 'SERVICE', 'PRICE (AFTER DISCOUNT)', 'MATERIALS COST', 'COMMISSION BASE', 'RATE', 'COMMISSION', 'STATUS', 'APPROVED ON', 'PAID ON', 'PAID BY', 'PAYMENT REFERENCE'],
        d.rows.map((x) => [x.date, x.receiptNo, x.branch, x.technician, (x.collab ? x.service + ' (collabo 50%)' : x.service) + (x.reversal ? ' (reversal)' : ''), x.price, x.materials, x.base, pct(x), x.commission, x.status,
          x.approvedAt ? x.approvedAt.slice(0, 10) : '', x.paidAt ? x.paidAt.slice(0, 10) : '', x.payMethod ?? '', x.payReference ?? ''])));
    }
    res.json(d);
  });
  app.get('/commissions/payslip', ...[auth, requireAny('commissions.view_all', 'commissions.view_own')], async (req, res) => {
    const d = await commissionLines(req, { ...req.query, status: 'all' });
    const name = d.rows[0]?.technician ?? null;
    let tech = name, specialty = null;
    const tid = req.user.permissions.has('commissions.view_all') ? int(req.query.technicianId, 'technician') : req.user.technicianId;
    const tr = await db.query(`SELECT t.display_name, sc.code AS specialty FROM technicians t LEFT JOIN service_categories sc ON sc.id = t.specialty_category_id WHERE t.id = $1`, [tid]);
    if (!tr.rowCount) throw new AppError(404, 'NOT_FOUND', 'Technician not found');
    tech = tr.rows[0].display_name; specialty = tr.rows[0].specialty;
    const sum = (f) => d.rows.filter(f).reduce((a, x) => a + x.commission, 0);
    const sign = (x) => (x.reversal ? -1 : 1);           // a voided sale is a reversal row that cancels the original
    const total = sum(() => true), paid = sum((x) => x.status === 'paid');
    res.json({ business: await loadBusiness(db, req.query.branchId), technician: tech, specialty, from: d.from, to: d.to, generated: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }),
      lines: d.rows, services: d.rows.reduce((a, x) => a + sign(x), 0), sales: d.rows.reduce((a, x) => a + sign(x) * x.price, 0), materials: d.rows.reduce((a, x) => a + sign(x) * x.materials, 0),
      total, paid, balance: total - paid, pending: sum((x) => x.status === 'pending'), approved: sum((x) => x.status === 'approved') });
  });

  // ---------- commission rules: never edited in place; the old rule is closed and a new one starts ----------
  app.get('/commission-rules', ...secure('commissions.view_all'), async (req, res) => {
    const r = await db.query(
      `SELECT id, scope, category_id, service_id, technician_id, calc_type, rate::float8 AS rate, fixed_amount::float8 AS fixed_amount, tiers, tier_base,
              effective_from::text AS effective_from, effective_to::text AS effective_to
         FROM commission_rules WHERE is_active ORDER BY scope, effective_from DESC`);
    res.json({ rows: r.rows });
  });
  app.post('/commission-rules', ...secure('commissions.rules.manage'), async (req, res) => {
    const b = req.body, reason = text(b.reason, 'A reason');
    const scope = oneOf(b.scope, ['default', 'category', 'service', 'technician', 'technician_service'], 'scope');
    const calc = oneOf(b.calcType, ['percent_of_price', 'percent_after_materials', 'fixed', 'tiered'], 'calcType');
    const from = date(b.effectiveFrom, 'effectiveFrom');
    const ids = { category: b.categoryId ?? null, service: b.serviceId ?? null, technician: b.technicianId ?? null };
    const need = { default: [], category: ['category'], service: ['service'], technician: ['technician'], technician_service: ['technician', 'service'] }[scope];
    for (const k of Object.keys(ids)) if (need.includes(k) ? ids[k] == null : ids[k] != null) throw new AppError(422, 'BAD_SCOPE', `A ${scope} rule needs exactly: ${need.join(' + ') || 'no ids'}`);
    let rate = null, fixed = null, tiers = null;
    if (calc === 'fixed') fixed = money(b.fixedAmount, 'fixedAmount');
    else if (calc === 'tiered') {
      if (!Array.isArray(b.tiers) || !b.tiers.length || !b.tiers.every((t) => Number(t.rate) >= 0 && Number(t.rate) <= 1 && (t.up_to === null || Number(t.up_to) > 0)) || b.tiers.filter((t) => t.up_to === null).length !== 1)
        throw new AppError(422, 'BAD_TIERS', 'Tiers need a rate between 0 and 1 and exactly one open-ended top tier (up_to: null)');
      tiers = b.tiers;
    } else { rate = Number(b.rate); if (!(rate >= 0 && rate <= 1)) throw new AppError(422, 'BAD_RATE', 'rate must be between 0 and 1 (0.4 = 40%)'); }
    const out = await tx({ userId: req.user.id, reason }, async (c) => {
      const same = await c.query(`SELECT id FROM commission_rules WHERE is_active AND scope = $1 AND category_id IS NOT DISTINCT FROM $2 AND service_id IS NOT DISTINCT FROM $3
            AND technician_id IS NOT DISTINCT FROM $4 AND effective_from = $5::date`, [scope, ids.category, ids.service, ids.technician, from]);
      if (same.rowCount) {                          // a correction made on the day the rule starts: update that rule (earlier commissions keep their own frozen copy)
        await c.query(`UPDATE commission_rules SET calc_type = $2, rate = $3, fixed_amount = $4, tiers = $5, tier_base = $6 WHERE id = $1`,
          [same.rows[0].id, calc, rate, fixed, tiers ? JSON.stringify(tiers) : null, b.tierBase === 'after_materials' ? 'after_materials' : 'price']);
        return { ruleId: Number(same.rows[0].id), effectiveFrom: from };
      }
      const clash = await c.query(
        `SELECT 1 FROM commission_rules WHERE is_active AND scope = $1 AND category_id IS NOT DISTINCT FROM $2 AND service_id IS NOT DISTINCT FROM $3
            AND technician_id IS NOT DISTINCT FROM $4 AND effective_from >= $5::date`, [scope, ids.category, ids.service, ids.technician, from]);
      if (clash.rowCount) throw new AppError(409, 'RULE_CONFLICT', 'A rule for this scope already starts on or after that date. Choose a later start date.');
      await c.query(
        `UPDATE commission_rules SET effective_to = $5::date WHERE is_active AND scope = $1 AND category_id IS NOT DISTINCT FROM $2
            AND service_id IS NOT DISTINCT FROM $3 AND technician_id IS NOT DISTINCT FROM $4 AND (effective_to IS NULL OR effective_to > $5::date)`, [scope, ids.category, ids.service, ids.technician, from]);
      const r = await c.query(
        `INSERT INTO commission_rules (scope, category_id, service_id, technician_id, calc_type, rate, fixed_amount, tiers, tier_base, effective_from, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [scope, ids.category, ids.service, ids.technician, calc, rate, fixed, tiers ? JSON.stringify(tiers) : null, b.tierBase === 'after_materials' ? 'after_materials' : 'price', from, req.user.id]);
      return { ruleId: Number(r.rows[0].id), effectiveFrom: from };
    });
    res.status(201).json(out);
  });

  // Remove a service's own commission rule so it goes back to its category's rule, from the given date.
  app.post('/commission-rules/clear', ...secure('commissions.rules.manage'), async (req, res) => {
    const b = req.body || {}, serviceId = int(b.serviceId, 'service'), from = date(b.effectiveFrom, 'effectiveFrom'), reason = text(b.reason, 'A reason');
    const out = await tx({ userId: req.user.id, reason }, async (c) => {
      await c.query(`UPDATE commission_rules SET is_active = false WHERE is_active AND scope = 'service' AND service_id = $1 AND effective_from >= $2::date`, [serviceId, from]);
      const r = await c.query(`UPDATE commission_rules SET effective_to = $2::date WHERE is_active AND scope = 'service' AND service_id = $1 AND (effective_to IS NULL OR effective_to > $2::date)`, [serviceId, from]);
      return { cleared: true, closedRules: r.rowCount, effectiveFrom: from };
    });
    res.json(out);
  });

  registerSettingsRoutes(app, { db, tx, secure });
  registerStaffRoutes(app, { db, tx, secure, branchList, v: { int } });
  registerGrowthRoutes(app, { db, tx, secure, v: { int, text, money, oneOf } });      // before the office routes so '/customers/due' is not read as a customer id
  registerOfficeRoutes(app, { db, tx, auth, secure, requireAny, requireBranch, branchList, v: { int, text, money, oneOf, range, date } });

  // ---------- catalogue + staff lists ----------
  app.get('/services', ...secure('services.view'), async (req, res) => {
    const r = await db.query(`SELECT s.id, s.code, s.name, s.category_id, sc.code AS category, s.standard_price, s.duration_minutes, s.is_active
                                FROM services s JOIN service_categories sc ON sc.id = s.category_id ORDER BY sc.code, s.name`);
    const cats = await db.query(`SELECT id, code, name FROM service_categories ORDER BY name`);
    const rl = await db.query(`SELECT id, scope, category_id, service_id, technician_id, calc_type, rate::float8 AS rate, fixed_amount::float8 AS fixed_amount, effective_from::text AS effective_from, effective_to::text AS effective_to, is_active
                                 FROM commission_rules WHERE is_active AND scope IN ('default','category','service')`);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }), seeRates = req.user.permissions.has('commissions.view_all');
    const rule = (serviceId, categoryId) => { try { return resolveRule(rl.rows, { serviceId, categoryId, onDate: today }); } catch { return null; } };
    const shape = (x) => x && ({ source: x.scope, calcType: x.calc_type, rate: x.rate, fixed: x.fixed_amount, effectiveFrom: x.effective_from });
    res.json({ canManage: req.user.permissions.has('services.manage'), canPrice: req.user.permissions.has('pricing.manage'), canCommission: req.user.permissions.has('commissions.rules.manage'),
      categories: cats.rows.map((c) => ({ id: Number(c.id), code: c.code, name: c.name, ...(seeRates ? { commission: shape(rule(-1, c.id)) } : {}) })),
      rows: r.rows.map((x) => { const ru = rule(x.id, x.category_id);
        return { id: Number(x.id), code: x.code, name: x.name, category: x.category, price: Number(x.standard_price), minutes: x.duration_minutes, active: x.is_active,
          needsMaterials: ru?.calc_type === 'percent_after_materials', ...(seeRates ? { commission: shape(ru) } : {}) }; }) });
  });
  // Add a service: { name, category: "NAILS", price, minutes }. The internal code is made from the category and name.
  app.post('/services', ...secure('services.manage'), async (req, res) => {
    const b = req.body || {}, name = text(b.name, 'Service name'), cat = String(b.category || '').toUpperCase(), price = money(b.price, 'Price'), minutes = int(b.minutes ?? 60, 'Duration');
    if (name.length > 80) throw new AppError(422, 'TOO_LONG', 'Service name is too long (80 characters at most)');
    if (minutes < 5 || minutes > 600) throw new AppError(422, 'BAD_DURATION', 'Duration must be between 5 and 600 minutes');
    const out = await tx({ userId: req.user.id, reason: 'Add service: ' + name }, async (c) => {
      const k = await c.query('SELECT id FROM service_categories WHERE code = $1', [cat]);
      if (!k.rowCount) throw new AppError(422, 'BAD_CATEGORY', 'Choose a category');
      const dup = await c.query('SELECT 1 FROM services WHERE category_id = $1 AND lower(name) = lower($2)', [k.rows[0].id, name]);
      if (dup.rowCount) throw new AppError(409, 'DUPLICATE', 'A service with this name already exists in that category');
      const base = `${cat.slice(0, 5)}-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}`;
      let code = base, n = 1;
      while ((await c.query('SELECT 1 FROM services WHERE code = $1', [code])).rowCount) code = `${base}-${++n}`;
      const r = await c.query(`INSERT INTO services (code, name, category_id, standard_price, duration_minutes) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [code, name, k.rows[0].id, price, minutes]);
      return { id: Number(r.rows[0].id), code };
    });
    res.status(201).json(out);
  });
  // Change a service: any of { name, category, minutes, active, price (+ reason) }. Past sales keep the name and price they were sold at.
  app.put('/services/:id', ...secure('services.manage'), async (req, res) => {
    const id = int(req.params.id, 'service'), b = req.body || {}, sets = [], vals = [id];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.name !== undefined) { const n = text(b.name, 'Service name'); if (n.length > 80) throw new AppError(422, 'TOO_LONG', 'Service name is too long'); add('name', n); }
    if (b.minutes !== undefined) { const m = int(b.minutes, 'Duration'); if (m < 5 || m > 600) throw new AppError(422, 'BAD_DURATION', 'Duration must be between 5 and 600 minutes'); add('duration_minutes', m); }
    if (b.active !== undefined) add('is_active', b.active === true);
    if (b.price !== undefined) {
      if (!req.user.permissions.has('pricing.manage')) throw new AppError(403, 'FORBIDDEN', 'You cannot change prices');
      add('standard_price', money(b.price, 'Price'));
    }
    const reason = b.price !== undefined ? text(b.reason, 'A reason for the price change') : 'Edit service';
    const out = await tx({ userId: req.user.id, reason }, async (c) => {
      if (b.category !== undefined) {
        const k = await c.query('SELECT id FROM service_categories WHERE code = $1', [String(b.category).toUpperCase()]);
        if (!k.rowCount) throw new AppError(422, 'BAD_CATEGORY', 'Choose a category');
        add('category_id', k.rows[0].id);
      }
      if (!sets.length) throw new AppError(422, 'NOTHING_TO_SAVE', 'Nothing to change');
      const r = await c.query(`UPDATE services SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`, vals);
      if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Service not found');
      return { id, note: 'New sales use these details. Past sales are not changed.' };
    });
    res.json(out);
  });
  // The "recipe" of a service: stock items taken from inventory each time it is sold (quantities can be adjusted at the till).
  app.get('/services/:id/materials', ...secure('services.manage'), async (req, res) => {
    const id = int(req.params.id, 'service');
    const r = await db.query(`SELECT sm.product_id, p.name, p.unit, sm.default_qty FROM service_materials sm JOIN products p ON p.id = sm.product_id WHERE sm.service_id = $1 ORDER BY p.name`, [id]);
    res.json({ rows: r.rows.map((x) => ({ productId: Number(x.product_id), name: x.name, unit: x.unit, qty: Number(x.default_qty) })) });
  });
  app.put('/services/:id/materials', ...secure('services.manage'), async (req, res) => {
    const id = int(req.params.id, 'service'), list = Array.isArray(req.body?.materials) ? req.body.materials : null;
    if (!list || list.length > 30) throw new AppError(422, 'BAD_MATERIALS', 'Send the list of materials (up to 30)');
    const seen = new Set(), rows = list.map((m) => {
      const pid = int(m.productId, 'Product'), q = Number(m.qty);
      if (!Number.isFinite(q) || q <= 0 || q > 10000) throw new AppError(422, 'BAD_QTY', 'Each quantity must be more than 0');
      if (seen.has(pid)) throw new AppError(422, 'DUPLICATE_PRODUCT', 'Each product can only be listed once'); seen.add(pid); return { pid, q: Math.round(q * 1000) / 1000 };
    });
    await tx({ userId: req.user.id, reason: 'Set service materials' }, async (c) => {
      if (!(await c.query('SELECT 1 FROM services WHERE id = $1', [id])).rowCount) throw new AppError(404, 'NOT_FOUND', 'Service not found');
      await c.query('DELETE FROM service_materials WHERE service_id = $1', [id]);
      for (const m of rows) {
        const ins = await c.query(`INSERT INTO service_materials (service_id, product_id, default_qty) SELECT $1, p.id, $3 FROM products p WHERE p.id = $2`, [id, m.pid, m.q]);
        if (!ins.rowCount) throw new AppError(422, 'BAD_PRODUCT', 'One of the products was not found');
      }
    });
    res.json({ saved: rows.length, note: 'New sales of this service will take these items out of stock.' });
  });
  app.get('/technicians', auth, requireAny('staff.view', 'sales.create'), async (req, res) => {
    const br = branchList(req.user, req.query.branchId);
    const r = await db.query(`SELECT t.id, t.display_name, t.phone, t.branch_id, sc.code AS specialty, t.is_active FROM technicians t
                                LEFT JOIN service_categories sc ON sc.id = t.specialty_category_id
                               WHERE ($1::bigint[] IS NULL OR t.branch_id = ANY($1)) ORDER BY t.display_name`, [br]);
    res.json({ rows: r.rows.map((x) => ({ id: Number(x.id), name: x.display_name, phone: x.phone, branchId: Number(x.branch_id), specialty: x.specialty, active: x.is_active })) });
  });
  // Add many technicians at once: { branchId, specialty: "NAILS"|"HAIR"|..., names: ["Mary W", "Jane A", ...] }. Names already on file are skipped.
  app.post('/technicians', ...secure('staff.manage'), requireBranch((r) => r.body.branchId), async (req, res) => {
    const b = req.body, branchId = int(b.branchId, 'branch'), specialty = String(b.specialty || '').toUpperCase();
    if (!Array.isArray(b.names) || !b.names.length || b.names.length > 200) throw new AppError(422, 'BAD_NAMES', 'names must be a list of 1 to 200 names');
    const names = [...new Set(b.names.map((n) => String(n || '').trim()).filter(Boolean))];
    const out = await tx({ userId: req.user.id }, async (c) => {
      const cat = await c.query('SELECT id FROM service_categories WHERE code = $1', [specialty]);
      if (!cat.rowCount) throw new AppError(422, 'BAD_SPECIALTY', 'specialty must be a category code such as NAILS or HAIR');
      let added = 0;
      for (const n of names) {
        const r = await c.query(`INSERT INTO technicians (branch_id, display_name, specialty_category_id)
                                 SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM technicians WHERE branch_id = $1 AND lower(display_name) = lower($2))`, [branchId, n, cat.rows[0].id]);
        added += r.rowCount;
      }
      return { added, skipped: names.length - added };
    });
    res.status(201).json(out);
  });

  // ---------- customers (search for the sale screen) ----------
  app.get('/customers', auth, requireAny('customers.view', 'customers.manage'), async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) throw new AppError(422, 'QUERY_TOO_SHORT', 'Type at least 2 characters of a name or phone number');
    const digits = q.replace(/\D/g, '');
    const r = await db.query(
      `SELECT id, customer_code, full_name, phone FROM customers WHERE deleted_at IS NULL
          AND (full_name ILIKE $1 OR ($2 <> '' AND phone_normalized LIKE $3)) ORDER BY full_name LIMIT 15`,
      ['%' + q.replace(/[%_\\]/g, '') + '%', digits, '%' + digits.replace(/^0+/, '') + '%']);
    res.json({ rows: r.rows.map((x) => ({ id: Number(x.id), code: x.customer_code, name: x.full_name, phone: x.phone })) });
  });

  // ---------- staff logins ----------
  app.post('/auth/change-password', auth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const u = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(currentPassword, u.rows[0].password_hash))) throw new AppError(401, 'INVALID_CREDENTIALS', 'Your current password is not correct');
    const hash = await hashPassword(newPassword);       // also enforces the password rules
    await tx({ userId: req.user.id, reason: 'Changed own password' }, (c) => c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, hash]));
    res.json({ ok: true });
  });
  app.get('/users', ...secure('users.manage'), async (req, res) => {
    const r = await db.query(`SELECT u.id, u.email, u.full_name, r.code AS role, u.is_active, u.last_login_at, t.display_name AS technician
                                FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN technicians t ON t.user_id = u.id ORDER BY u.id`);
    res.json({ rows: r.rows.map((x) => ({ id: Number(x.id), email: x.email, name: x.full_name, role: x.role, active: x.is_active, lastLogin: x.last_login_at, technician: x.technician })) });
  });
  // Create one login. Role may not be super_admin. For a technician, pass technicianId to link the login to that technician.
  app.post('/users', ...secure('users.manage'), async (req, res) => {
    const b = req.body || {}, role = oneOf(b.roleCode, ['owner', 'manager', 'receptionist', 'technician', 'accountant'], 'role');
    const email = String(b.email || '').trim().toLowerCase(); if (!email) throw new AppError(422, 'BAD_EMAIL', 'A login name or email is required');
    const branchIds = (b.branchIds || []).map((x) => int(x, 'branch'));
    const out = await tx({ userId: req.user.id, reason: `Create ${role} login` }, async (c) => {
      const dup = await c.query('SELECT 1 FROM users WHERE email = $1', [email]); if (dup.rowCount) throw new AppError(409, 'EMAIL_TAKEN', 'That login name is already used');
      const id = await createUser(c, { email, fullName: text(b.fullName, 'Full name'), password: b.password, roleCode: role, branchIds });
      if (b.technicianId) {
        const t = await c.query('UPDATE technicians SET user_id = $2 WHERE id = $1 AND user_id IS NULL RETURNING id', [int(b.technicianId, 'technician'), id]);
        if (!t.rowCount) throw new AppError(409, 'TECHNICIAN_UNAVAILABLE', 'Technician not found or already has a login');
      }
      return { id, email };
    });
    res.status(201).json(out);
  });
  // Give EVERY technician without a login one: login name = firstname@cutenails.local, plus a one-time temporary password.
  app.post('/users/technician-logins', ...secure('users.manage'), async (req, res) => {
    const out = await tx({ userId: req.user.id, reason: 'Create technician logins' }, async (c) => {
      const ts = await c.query('SELECT id, display_name, branch_id FROM technicians WHERE user_id IS NULL AND is_active ORDER BY display_name');
      const made = [];
      for (const t of ts.rows) {
        let email = `${slug(t.display_name)}@cutenails.local`, n = 1;
        while ((await c.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount) email = `${slug(t.display_name)}${++n}@cutenails.local`;
        const password = tempPassword();
        const id = await createUser(c, { email, fullName: t.display_name, password, roleCode: 'technician', branchIds: [Number(t.branch_id)] });
        await c.query('UPDATE technicians SET user_id = $2 WHERE id = $1', [t.id, id]);
        made.push({ technician: t.display_name, login: email, password });
      }
      return { created: made.length, logins: made, note: 'Shown once. Hand each person their own login, then ask them to change the password.' };
    });
    res.status(201).json(out);
  });
  app.post('/users/:id/reset-password', ...secure('users.manage'), async (req, res) => {
    const id = int(req.params.id, 'user'), password = req.body?.password || tempPassword(), hash = await hashPassword(password);
    const out = await tx({ userId: req.user.id, reason: 'Admin password reset' }, async (c) => {
      const r = await c.query('UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1 AND is_active RETURNING email', [id, hash]);
      if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'User not found');
      return { login: r.rows[0].email, password };
    });
    res.json(out);
  });

  // ---------- prices ----------
  app.put('/services/:id/price', ...secure('pricing.manage'), async (req, res) => {
    const id = int(req.params.id, 'service'), price = money(req.body.price, 'price'), reason = text(req.body.reason, 'A reason');
    const out = await tx({ userId: req.user.id, reason }, async (c) => {
      let r;
      if (req.body.branchId) r = await c.query(
        `INSERT INTO service_branch_prices (service_id, branch_id, price) VALUES ($1,$2,$3)
         ON CONFLICT (service_id, branch_id) DO UPDATE SET price = EXCLUDED.price, updated_at = now() RETURNING service_id`, [id, int(req.body.branchId, 'branch'), price]);
      else r = await c.query('UPDATE services SET standard_price = $2 WHERE id = $1 RETURNING id', [id, price]);
      if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Service not found');
      return { serviceId: id, price, note: 'New sales use this price. Past sales are not changed.' };
    });
    res.json(out);
  });

  // ---------- inventory + alerts ----------
  app.post('/inventory/adjust', ...secure('inventory.manage'), requireBranch((r) => r.body.branchId), async (req, res) => {
    const b = req.body, type = oneOf(b.type, ['purchase', 'adjustment', 'damaged', 'expired', 'return'], 'type'), reason = text(b.reason, 'A reason');
    const q = Number(b.qty); if (!Number.isFinite(q) || q === 0) throw new AppError(422, 'BAD_QTY', 'qty must be a non-zero number');
    const qty = type === 'adjustment' ? q : ['damaged', 'expired'].includes(type) ? -Math.abs(q) : Math.abs(q);
    const unitCost = type === 'purchase' ? money(b.unitCost, 'unitCost') : null;
    const out = await tx({ userId: req.user.id, reason }, async (c) => {
      const mv = await moveStock(c, { productId: int(b.productId, 'product'), branchId: int(b.branchId, 'branch'), qty, type, unitCost, reason,
        refType: 'manual', refId: null, userId: req.user.id, allowNegative: true });
      if (mv.onHand >= 0) await c.query(
        `UPDATE alerts SET resolved_at = now() WHERE rule_code = 'negative_stock' AND entity_type = 'product' AND entity_id = $1 AND branch_id = $2 AND resolved_at IS NULL`,
        [Number(b.productId), Number(b.branchId)]);
      return { onHand: mv.onHand };
    });
    res.status(201).json(out);
  });
  app.get('/alerts', ...[auth, requireAny('dashboard.view', 'inventory.view')], async (req, res) => {
    const br = branchList(req.user, req.query.branchId);
    const r = await db.query(`SELECT id, rule_code, branch_id, entity_type, entity_id, message, created_at FROM alerts
       WHERE resolved_at IS NULL AND ($1::bigint[] IS NULL OR branch_id = ANY($1) OR branch_id IS NULL) ORDER BY created_at DESC LIMIT 200`, [br]);
    res.json({ rows: r.rows });
  });

  // ---------- historical import (Excel / CSV) ----------
  // The file travels as base64 inside JSON ({ filename, contentBase64, options }), so no multipart parser is needed. Limit: 12 MB of file.
  const IMPORT_MAX_BYTES = 12 * 1024 * 1024, bigBody = { maxBody: Math.ceil(IMPORT_MAX_BYTES * 1.4) };
  const strMap = (o, name) => {
    if (o == null) return {};
    if (typeof o !== 'object' || Array.isArray(o) || Object.keys(o).length > 500 || !Object.values(o).every((v) => typeof v === 'string' && v.length < 200))
      throw new AppError(422, 'BAD_OPTIONS', `${name} must be a list of name -> name pairs`);
    return o;
  };
  const importInput = (req) => {
    const b = req.body || {}, o = b.options || {};
    if (typeof b.contentBase64 !== 'string' || !b.contentBase64) throw new AppError(422, 'FILE_REQUIRED', 'Choose an Excel (.xlsx) or CSV file');
    const buffer = Buffer.from(b.contentBase64, 'base64');
    if (!buffer.length) throw new AppError(422, 'FILE_REQUIRED', 'The file is empty');
    if (buffer.length > IMPORT_MAX_BYTES) throw new AppError(413, 'TOO_LARGE', 'File is larger than 12 MB. Split it by year and import each part.');
    const allowed = branchList(req.user, o.branchId);                    // null = every branch
    const options = {
      dateFormat: o.dateFormat === 'mdy' ? 'mdy' : 'dmy',
      createServices: o.createServices === true, createTechnicians: o.createTechnicians === true,
      unknownMaterials: o.unknownMaterials === 'ignore' ? 'ignore' : 'error',
      skipInvalidRows: o.skipInvalidRows === true, onOverlap: o.onOverlap === 'import' ? 'import' : 'skip',
      branchId: o.branchId ? int(o.branchId, 'branch') : null, defaultTechnicianId: o.defaultTechnicianId ? int(o.defaultTechnicianId, 'technician') : null,
      serviceAliases: strMap(o.serviceAliases, 'serviceAliases'), technicianAliases: strMap(o.technicianAliases, 'technicianAliases'),
      mapping: strMap(o.mapping, 'mapping'), paidBefore: o.paidBefore ? date(o.paidBefore, 'paidBefore') : null,
      sheet: typeof o.sheet === 'string' ? o.sheet.slice(0, 100) : undefined, allowedBranchIds: allowed,
    };
    if (options.createServices && !req.user.permissions.has('services.manage')) throw new AppError(403, 'FORBIDDEN', 'You cannot create services');
    if (options.createTechnicians && !req.user.permissions.has('staff.manage')) throw new AppError(403, 'FORBIDDEN', 'You cannot add staff');
    return { buffer, filename: String(b.filename || 'upload').slice(0, 200), options };
  };
  app.post('/import/preview', bigBody, ...secure('data.import'), async (req, res) => {
    const { buffer, filename, options } = importInput(req);
    res.json(await importer.previewImport(db, buffer, filename, options));
  });
  app.post('/import/commit', bigBody, ...secure('data.import'), async (req, res) => {
    const { buffer, filename, options } = importInput(req);
    const reason = `Historical import: ${filename}`;
    res.status(201).json(await tx({ userId: req.user.id, reason }, (c) => importer.commitImport(c, buffer, filename, options, { userId: req.user.id })));
  });
  app.get('/import/batches', ...secure('data.import'), async (req, res) => res.json({ rows: await importer.listBatches(db) }));
  app.post('/import/:batchId/rollback', ...secure('data.import'), async (req, res) => {
    const reason = text(req.body.reason, 'A reason');
    res.json(await tx({ userId: req.user.id, reason }, (c) => importer.rollbackBatch(c, int(req.params.batchId, 'batch'), { userId: req.user.id, reason })));
  });
  return app;
}
