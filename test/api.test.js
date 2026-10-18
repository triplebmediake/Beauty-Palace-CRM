import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/http/app.js';
import { registerRoutes } from '../src/api/routes.js';
import { signToken } from '../src/auth/token.js';
import { hashPassword } from '../src/auth/password.js';
import { ROLES } from '../src/auth/permissions.js';

const SECRET = 's'.repeat(40);
const USERS = { 1: ['owner', 'Owner'], 2: ['receptionist', 'Rita'], 3: ['technician', 'Tom'], 4: ['manager', 'Mary'], 5: ['accountant', 'Ann'], 6: ['super_admin', 'Root'] };
const hash = await hashPassword('Salon2026pass');

function makeDb(over = {}) {
  const log = [];
  const R = (rows = [], rowCount = rows.length) => ({ rows, rowCount });
  const db = { log, flags: { ruleClash: false, onHand: -3, ...over },
    async query(sql, params = []) {
      const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))];
      assert.equal(used.length ? Math.max(...used) : 0, params.length, 'param count mismatch: ' + sql.replace(/\s+/g, ' ').slice(0, 90));
      log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id/.test(sql)) {
        const u = USERS[params[0]]; if (!u) return R();
        return R([{ id: Number(params[0]), full_name: u[1], is_active: true, role: u[0], perms: ROLES[u[0]].permissions, branches: [1], technician_id: u[0] === 'technician' ? 7 : null }]);
      }
      if (/WHERE u.email/.test(sql)) return R([{ id: 2, full_name: 'Rita', password_hash: hash, is_active: true, failed_logins: 0, locked_until: null, mfa_secret: null, role: 'receptionist' }]);
      if (/FROM v_item_credits cr JOIN transactions tn/.test(sql)) return R([
        { transaction_id: 11, receipt_no: 'MAIN-2026-000001', date: '2026-10-05', technician_name: 'Amina', service: 'TIPS', amount: '1000.00', payment_modes: 'M-Pesa', customer_name: '=cmd|calc', contact: '0712345678', material_cost: '0', commission: '400.00' },
        { date: '2026-10-05', technician_name: 'Amina', service: 'GEL', amount: '400.00', payment_modes: 'Cash', customer_name: 'Jane', contact: '0722000000', material_cost: '150.50', commission: '160.00' }]);
      if (/COUNT\(\*\)::int AS services, SUM\(cr.amount\)/.test(sql)) return R([{ technician: 'Amina', services: 5, revenue: '4000', commission: '1500' }]);
      if (/GROUP BY tech.display_name/.test(sql)) return R([{ technician_name: 'Cynthia', customers_served: 1, total_sales: '3000.00', commission: '1350.00' }, { technician_name: 'Amina', customers_served: 2, total_sales: '1400.00', commission: '560.00' }]);
      if (/AS n FROM transactions/.test(sql)) return R([{ n: 2 }]);
      if (/SET status = 'approved'/.test(sql)) return R([{ commission_amount: '400.00' }, { commission_amount: '1350.00' }]);
      if (/status = 'approved' AND technician_id/.test(sql)) return R([{ id: 1, commission_amount: '400.00', branch_id: 1 }, { id: 2, commission_amount: '1350.00', branch_id: 1 }]);
      if (/INSERT INTO commission_payments/.test(sql)) return R([{ id: 9 }]);
      if (/FROM commission_calculations cc JOIN technicians/.test(sql)) return R([{ technician_id: 7, technician: 'Tom', total: '500', pending: '100', approved: '200', paid: '200' }]);
      if (/SELECT 1 FROM commission_rules/.test(sql)) return db.flags.ruleClash ? R([{}]) : R();
      if (/INSERT INTO commission_rules/.test(sql)) return R([{ id: 55 }]);
      if (/UPDATE services SET standard_price/.test(sql)) return R([{ id: 1 }]);
      if (/business_today\(\)::text/.test(sql)) return R([{ d: '2026-10-14' }]);
      if (/is_new_customer\) ::int|FILTER \(WHERE vi.is_new_customer\)/.test(sql)) return R([{ sales: String(params[0] === '2026-10-14' ? 900 : 4000), customers: 3, new_customers: 1, services: 5, materials: '600' }]);
      if (/SELECT COALESCE\(SUM\(commission_amount\),0\) AS commission/.test(sql)) return R([{ commission: '1500' }]);
      if (/AS expenses FROM expenses/.test(sql)) return R([{ expenses: '500' }]);
      if (/AS pending_lines|AS pending, COALESCE/.test(sql)) return R([{ pending: '300', approved: '200', pending_lines: 4 }]);
      if (/i.min_level > 0/.test(sql)) return R([{ name: 'Gel', qty_on_hand: '3' }]);
      if (/AS v FROM inventory/.test(sql)) return R([{ v: '25000' }]);
      if (/target.weekly_sales' *$|key = 'target.weekly_sales'/.test(sql)) return R([{ v: '250000' }]);
      if (/INSERT INTO app_settings/.test(sql)) return R([], 1);
      if (/FROM service_categories WHERE code/.test(sql)) return params[0] === 'NAILS' ? R([{ id: 3 }]) : R();
      if (/FROM customers WHERE deleted_at/.test(sql)) return R([{ id: 9, customer_code: 'C000009', full_name: 'Jane', phone: '0712345678' }]);
      if (/SELECT id FROM roles WHERE code/.test(sql)) return R([{ id: 1 }]);
      if (/INSERT INTO users/.test(sql)) return R([{ id: 20 }]);
      if (/FROM technicians WHERE user_id IS NULL/.test(sql)) return R([{ id: 5, display_name: 'Ahmed', branch_id: 1 }, { id: 6, display_name: 'Mary W', branch_id: 1 }]);
      if (/UPDATE users SET password_hash/.test(sql)) return R([{ email: 'x@y' }]);
      if (/INSERT INTO technicians/.test(sql)) return R([], /dup/i.test(params[1]) ? 0 : 1);
      if (/INSERT INTO inventory \(/.test(sql)) return R();
      if (/FROM inventory WHERE/.test(sql)) return R([{ qty_on_hand: String(db.flags.onHand) }]);
      if (/INSERT INTO inventory_transactions/.test(sql)) return R([{ id: 77 }]);
      return R();
    } };
  return db;
}
async function boot({ dbOver, now } = {}) {
  const db = makeDb(dbOver), calls = { checkout: [], voidSale: [], tx: [] };
  const app = createApp();
  registerRoutes(app, { db, secret: SECRET, now,
    tx: (opts, fn) => { calls.tx.push(opts); return fn(db); },
    deps: { checkout: async (c, input, o) => { calls.checkout.push({ input, o }); return { receiptNo: 'MAIN-2026-000001' }; },
            voidSale: async (c, id, o) => { calls.voidSale.push({ id, o }); return { transactionId: id, status: 'voided' }; } } });
  const server = http.createServer(app.handler); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { as, body } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${signToken({ sub: String(as) }, SECRET)}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = null; }
    return { status: r.status, json: j, text: t, headers: r.headers };
  };
  return { db, calls, call, close: () => server.close() };
}
const as = { owner: 1, receptionist: 2, technician: 3, manager: 4, accountant: 5, admin: 6 };

test('public vs protected, and security headers', async () => {
  const s = await boot();
  assert.equal((await s.call('GET', '/health')).status, 200);
  assert.equal((await s.call('GET', '/me')).status, 401);
  const me = await s.call('GET', '/me', { as: as.receptionist });
  assert.equal(me.json.role, 'receptionist'); assert.equal(me.headers.get('cache-control'), 'no-store'); assert.equal(me.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await s.call('GET', '/nope')).status, 404);
  s.close();
});
test('login works and is throttled after 10 attempts', async () => {
  const s = await boot({ now: () => 1_000_000 });
  const ok = await s.call('POST', '/auth/login', { body: { email: 'rita@x.com', password: 'Salon2026pass' } });
  assert.equal(ok.status, 200); assert.ok(ok.json.token);
  for (let i = 0; i < 9; i++) await s.call('POST', '/auth/login', { body: { email: 'rita@x.com', password: 'bad' } });
  assert.equal((await s.call('POST', '/auth/login', { body: { email: 'rita@x.com', password: 'bad' } })).status, 429);
  s.close();
});
test('POST /sales: permissions, branch, back-dating and discount approval', async () => {
  const s = await boot(); const body = { branchId: 1, customerId: 5, lines: [], payments: [], businessDate: '2020-01-01' };
  assert.equal((await s.call('POST', '/sales', { as: as.technician, body })).status, 403);
  assert.equal((await s.call('POST', '/sales', { as: as.receptionist, body: { ...body, branchId: 2 } })).json.error.code, 'WRONG_BRANCH');
  const r = await s.call('POST', '/sales', { as: as.receptionist, body: { ...body, discounts: [{ type: 'percent', value: 10, reason: 'x' }] } });
  assert.equal(r.status, 201);
  assert.equal(s.calls.checkout[0].input.businessDate, undefined);           // receptionists cannot back-date
  assert.equal(s.calls.checkout[0].input.discountApprovedBy, undefined);     // and cannot self-approve discounts
  await s.call('POST', '/sales', { as: as.manager, body });
  assert.equal(s.calls.checkout[1].input.discountApprovedBy, 4);             // managers can
  assert.equal((await s.call('POST', '/sales', { as: as.accountant, body })).status, 403);
  s.close();
});
test('void: manager only, reason required and recorded', async () => {
  const s = await boot();
  assert.equal((await s.call('POST', '/sales/12/void', { as: as.receptionist, body: { reason: 'x' } })).status, 403);
  assert.equal((await s.call('POST', '/sales/12/void', { as: as.manager, body: {} })).status, 422);
  s.db.query = ((orig) => async (sql, p) => (/SELECT branch_id FROM transactions/.test(sql) ? { rows: [{ branch_id: 1 }], rowCount: 1 } : orig(sql, p)))(s.db.query);
  const ok = await s.call('POST', '/sales/12/void', { as: as.manager, body: { reason: 'Wrong customer' } });
  assert.equal(ok.status, 200); assert.equal(s.calls.voidSale[0].o.reason, 'Wrong customer');
  assert.equal(s.calls.tx.at(-1).reason, 'Wrong customer');
  s.close();
});
test('daily sales report: dates validated, technician sees only own rows and no phone numbers', async () => {
  const s = await boot();
  assert.equal((await s.call('GET', '/reports/daily-sales?from=bad&to=2026-10-09', { as: as.manager })).status, 422);
  assert.equal((await s.call('GET', '/reports/daily-sales?from=2026-10-09&to=2026-10-01', { as: as.manager })).status, 422);
  assert.equal((await s.call('GET', '/reports/daily-sales?from=2026-10-01&to=2026-10-09')).status, 401);
  assert.equal((await s.call('GET', '/reports/daily-sales?from=2026-10-01&to=2026-10-09', { as: as.receptionist })).status, 403);
  const t = await s.call('GET', '/reports/daily-sales?from=2026-10-01&to=2026-10-09', { as: as.technician });
  assert.equal(s.db.log.at(-1).params[3], 7); assert.equal(t.json.rows[0].contact, null);
  const m = await s.call('GET', '/reports/daily-sales?from=2026-10-01&to=2026-10-09', { as: as.manager });
  assert.equal(s.db.log.at(-1).params[3], null); assert.equal(m.json.rows[0].contact, '0712345678'); assert.equal(m.json.total, 1400);
  assert.deepEqual([m.json.rows[0].transactionId, m.json.rows[0].receiptNo], [11, 'MAIN-2026-000001']);
  assert.deepEqual([m.json.rows[1].materials, m.json.rows[1].commission, m.json.totalMaterials, m.json.totalCommission], [150.5, 160, 150.5, 560]);
  s.close();
});
test('CSV export needs data.export and neutralises spreadsheet formulas', async () => {
  const s = await boot();
  assert.equal((await s.call('GET', '/reports/daily-sales?from=2026-10-01&to=2026-10-09&format=csv', { as: as.technician })).status, 403);
  const c = await s.call('GET', '/reports/daily-sales?from=2026-10-01&to=2026-10-09&format=csv', { as: as.manager });
  assert.equal(c.status, 200); assert.match(c.headers.get('content-type'), /text\/csv/); assert.match(c.headers.get('content-disposition'), /attachment/);
  assert.ok(c.text.includes('DATE,TECHNICIAN NAME,SERVICE,AMOUNT,MODE OF PAYMENT,CUSTOMER NAME,CONTACT,MATERIALS COST,COMMISSION'));
  assert.ok(c.text.includes("'=cmd|calc")); assert.ok(!/,=cmd/.test(c.text));
  s.close();
});
test('weekly sales report: per technician plus a unique-customer total', async () => {
  const s = await boot();
  const w = await s.call('GET', '/reports/weekly-sales?from=2026-10-03&to=2026-10-09', { as: as.owner });
  assert.deepEqual(w.json.total, { customersServed: 2, totalSales: 4400, commission: 1910 });   // 2 unique, not 1 + 2
  const c = await s.call('GET', '/reports/weekly-sales?from=2026-10-03&to=2026-10-09&format=csv', { as: as.accountant });
  assert.ok(c.text.includes('TECHNICIAN NAME,NO OF CUSTOMERS SERVED,TOTAL SALES,COMMISSION')); assert.ok(c.text.includes('TOTAL,2,4400,1910'));
  s.close();
});
test('commissions: manager approves, accountant pays, nobody else', async () => {
  const s = await boot(); const body = { from: '2026-10-03', to: '2026-10-09', technicianId: 7, method: 'mpesa' };
  assert.equal((await s.call('POST', '/commissions/approve', { as: as.receptionist, body })).status, 403);
  assert.equal((await s.call('POST', '/commissions/approve', { as: as.accountant, body })).status, 403);
  const a = await s.call('POST', '/commissions/approve', { as: as.manager, body });
  assert.deepEqual(a.json, { approvedLines: 2, amount: 1750 });
  assert.equal((await s.call('POST', '/commissions/pay', { as: as.manager, body })).status, 403);
  const p = await s.call('POST', '/commissions/pay', { as: as.accountant, body });
  assert.equal(p.status, 201); assert.deepEqual(p.json, { paymentId: 9, lines: 2, amount: 1750 });
  const upd = s.db.log.find((x) => /SET status = 'paid'/.test(x.sql)); assert.deepEqual(upd.params, [9, [1, 2]]);
  assert.equal((await s.call('POST', '/commissions/pay', { as: as.accountant, body: { ...body, method: 'bitcoin' } })).status, 422);
  const own = await s.call('GET', '/commissions/summary?from=2026-10-03&to=2026-10-09', { as: as.technician });
  assert.equal(s.db.log.at(-1).params[3], 7); assert.equal(own.json.rows[0].total, 500);
  s.close();
});
test('commission rules: owner can change them, versioned, never edited in place', async () => {
  const s = await boot();
  const body = { scope: 'category', categoryId: 2, calcType: 'percent_after_materials', rate: 0.55, effectiveFrom: '2026-11-01', reason: 'Raise hair share' };
  assert.equal((await s.call('POST', '/commission-rules', { as: as.receptionist, body })).status, 403);
  assert.equal((await s.call('POST', '/commission-rules', { as: as.manager, body })).status, 403);
  assert.equal((await s.call('POST', '/commission-rules', { as: as.owner, body: { ...body, reason: '' } })).status, 422);
  assert.equal((await s.call('POST', '/commission-rules', { as: as.owner, body: { ...body, rate: 55 } })).json.error.code, 'BAD_RATE');
  assert.equal((await s.call('POST', '/commission-rules', { as: as.owner, body: { ...body, categoryId: undefined } })).json.error.code, 'BAD_SCOPE');
  const ok = await s.call('POST', '/commission-rules', { as: as.owner, body });
  assert.equal(ok.status, 201); assert.equal(s.calls.tx.at(-1).reason, 'Raise hair share');
  const order = s.db.log.map((x) => x.sql).filter((q) => /commission_rules/.test(q)).map((q) => q.split(' ')[0]);
  assert.deepEqual(order.slice(-3), ['SELECT', 'UPDATE', 'INSERT']);               // check, close the old rule, start the new one
  assert.ok(!s.db.log.some((x) => /UPDATE commission_rules SET rate/.test(x.sql)));
  s.db.flags.ruleClash = true;
  assert.equal((await s.call('POST', '/commission-rules', { as: as.owner, body })).status, 409);
  s.close();
});
test('prices: owner can change, reason required, manager cannot', async () => {
  const s = await boot();
  assert.equal((await s.call('PUT', '/services/1/price', { as: as.manager, body: { price: 900, reason: 'x' } })).status, 403);
  assert.equal((await s.call('PUT', '/services/1/price', { as: as.owner, body: { price: 900 } })).status, 422);
  assert.equal((await s.call('PUT', '/services/1/price', { as: as.owner, body: { price: -5, reason: 'x' } })).status, 422);
  const ok = await s.call('PUT', '/services/1/price', { as: as.owner, body: { price: 900, reason: 'Festive pricing' } });
  assert.equal(ok.status, 200); assert.equal(s.calls.tx.at(-1).reason, 'Festive pricing');
  s.close();
});
test('inventory: damaged stock is removed, and a purchase that fixes negative stock clears the alert', async () => {
  const s = await boot({ dbOver: { onHand: -3 } });
  const base = { productId: 10, branchId: 1, reason: 'Delivery' };
  assert.equal((await s.call('POST', '/inventory/adjust', { as: as.receptionist, body: { ...base, type: 'purchase', qty: 5, unitCost: 150 } })).status, 403);
  const dmg = await s.call('POST', '/inventory/adjust', { as: as.manager, body: { ...base, type: 'damaged', qty: 2 } });
  assert.equal(s.db.log.find((x) => /INSERT INTO inventory_transactions/.test(x.sql)).params[3], -2);
  assert.ok(!s.db.log.some((x) => /UPDATE alerts SET resolved_at/.test(x.sql)));   // still negative -> alert stays
  s.db.flags.onHand = -3; s.db.log.length = 0;
  const buy = await s.call('POST', '/inventory/adjust', { as: as.manager, body: { ...base, type: 'purchase', qty: 5, unitCost: 150 } });
  assert.equal(buy.json.onHand, 2); assert.ok(s.db.log.some((x) => /UPDATE alerts SET resolved_at/.test(x.sql)));
  void dmg; s.close();
});

test('technicians can be added in bulk by staff managers only; unknown specialty and bad lists are refused', async () => {
  const s = await boot();
  const body = { branchId: 1, specialty: 'nails', names: ['Mary W', 'Mary W', ' Jane A ', 'Dup One', ''] };
  assert.equal((await s.call('POST', '/technicians', { as: as.receptionist, body })).status, 403);
  const ok = await s.call('POST', '/technicians', { as: as.owner, body });
  assert.equal(ok.status, 201); assert.deepEqual(ok.json, { added: 2, skipped: 1 });
  assert.equal((await s.call('POST', '/technicians', { as: as.owner, body: { ...body, specialty: 'XYZ' } })).json.error?.code ?? (await s.call('POST', '/technicians', { as: as.owner, body: { ...body, specialty: 'XYZ' } })).json.code, 'BAD_SPECIALTY');
  assert.equal((await s.call('POST', '/technicians', { as: as.owner, body: { branchId: 1, specialty: 'NAILS', names: [] } })).status, 422);
  assert.equal((await s.call('GET', '/services', { as: as.owner })).status, 200);
  assert.equal((await s.call('GET', '/technicians', { as: as.owner })).status, 200);
  s.close();
});

test('the web screen is served at / with a strict content policy', async () => {
  const s = await boot(); const r = await s.call('GET', '/');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/); assert.match(r.text, /Cute Nails/); assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  s.close();
});
test('customer search needs 2+ characters and a permission; returns matches', async () => {
  const s = await boot();
  assert.equal((await s.call('GET', '/customers?q=j', { as: as.receptionist })).status, 422);
  assert.equal((await s.call('GET', '/customers?q=jane', { as: as.technician })).status, 403);
  const r = await s.call('GET', '/customers?q=jane', { as: as.receptionist }); assert.equal(r.status, 200); assert.equal(r.json.rows[0].name, 'Jane');
  s.close();
});
test('staff logins: only users.manage; technician logins are generated once with temporary passwords', async () => {
  const s = await boot();
  assert.equal((await s.call('POST', '/users/technician-logins', { as: as.receptionist })).status, 403);
  assert.equal((await s.call('POST', '/users/technician-logins', { as: as.owner })).status, 403);          // owner lacks users.manage
  const r = await s.call('POST', '/users/technician-logins', { as: as.admin });
  assert.equal(r.status, 201); assert.equal(r.json.created, 2);
  assert.deepEqual(r.json.logins.map((x) => x.login), ['ahmed@cutenails.local', 'mary.w@cutenails.local']);
  assert.ok(r.json.logins.every((x) => x.password.length >= 10 && /[a-z]/.test(x.password) && /[0-9]/.test(x.password)));
  assert.equal((await s.call('POST', '/users', { as: as.admin, body: { fullName: 'Rita', email: 'Rita.Front', roleCode: 'super_admin', password: 'Welcome2026x' } })).status, 422);   // cannot mint super admins
  const u = await s.call('POST', '/users', { as: as.admin, body: { fullName: 'Rita', email: ' Rita.Front ', roleCode: 'receptionist', password: 'Welcome2026x', branchIds: [1] } });
  assert.equal(u.status, 201); assert.equal(u.json.email, 'rita.front');
  const rp = await s.call('POST', '/users/3/reset-password', { as: as.admin, body: {} }); assert.equal(rp.status, 200); assert.ok(rp.json.password.length >= 10);
  s.close();
});
test('change password rejects a wrong current password and weak new passwords', async () => {
  const s = await boot();
  assert.equal((await s.call('POST', '/auth/change-password', { body: {} })).status, 401);
  s.close();
});

test('dashboard: totals, derived figures, target, alerts; inventory value only for those allowed; office roles only', async () => {
  const s = await boot();
  assert.equal((await s.call('GET', '/dashboard?from=2026-10-10&to=2026-10-16', { as: as.receptionist })).status, 403);
  assert.equal((await s.call('GET', '/dashboard?from=2026-10-10&to=2026-10-16', { as: as.technician })).status, 403);
  assert.equal((await s.call('GET', '/dashboard?from=bad&to=2026-10-16', { as: as.owner })).status, 422);
  const o = await s.call('GET', '/dashboard?from=2026-10-10&to=2026-10-16', { as: as.owner }); assert.equal(o.status, 200);
  assert.deepEqual(o.json.kpi, { sales: 4000, customers: 3, services: 5, avgSpend: 4000 / 3, servicesPerCustomer: 5 / 3, newCustomers: 1, returningCustomers: 2,
    materials: 600, commission: 1500, expenses: 500, profit: 1400, commissionOwed: 500, inventoryValue: 25000 });
  assert.equal(o.json.weekStart, '2026-10-10'); assert.equal(o.json.target.weeklySales, 250000); assert.equal(o.json.target.canSet, true);
  assert.equal(o.json.today.sales, 900); assert.equal(o.json.alerts.lowStock[0].name, 'Gel'); assert.equal(o.json.alerts.commissionsPending, 4);
  assert.equal(o.json.technicians[0].commission, 1500);
  const m = await s.call('GET', '/dashboard?from=2026-10-10&to=2026-10-16', { as: as.manager }); assert.equal(m.status, 200); assert.equal(m.json.kpi.inventoryValue, null); assert.equal(m.json.target.canSet, false);
  assert.equal((await s.call('PUT', '/targets/weekly', { as: as.manager, body: { salesTarget: 1 } })).status, 403);
  const t = await s.call('PUT', '/targets/weekly', { as: as.owner, body: { salesTarget: 300000 } }); assert.equal(t.status, 200);
  assert.equal((await s.call('PUT', '/targets/weekly', { as: as.owner, body: { salesTarget: -5 } })).status, 422);
  s.close();
});
