import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/http/app.js';
import { registerRoutes } from '../src/api/routes.js';
import { signToken } from '../src/auth/token.js';
import { ROLES } from '../src/auth/permissions.js';

const SECRET = 's'.repeat(40);
const USERS = { 1: 'owner', 2: 'receptionist', 3: 'technician', 4: 'manager', 5: 'accountant', 6: 'super_admin' };
const R = (rows = [], rowCount = rows.length) => ({ rows, rowCount });

async function boot(handlers = []) {
  const log = [];
  const db = { log, async query(sql, params = []) {
    const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))];
    assert.equal(used.length ? Math.max(...used) : 0, params.length, 'param count mismatch: ' + sql.replace(/\s+/g, ' ').slice(0, 100));
    log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id/.test(sql)) { const role = USERS[params[0]]; return R([{ id: Number(params[0]), full_name: 'U', is_active: true, role, perms: ROLES[role].permissions, branches: [1], technician_id: role === 'technician' ? 7 : null }]); }
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params, sql);
    return R();
  } };
  const app = createApp();
  registerRoutes(app, { db, secret: SECRET, tx: (o, fn) => fn(db), deps: {} });
  const server = http.createServer(app.handler); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { as, body } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${signToken({ sub: String(as) }, SECRET)}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { status: r.status, json: j };
  };
  return { db, call, close: () => server.close() };
}
const as = { owner: 1, receptionist: 2, technician: 3, manager: 4, accountant: 5, admin: 6 };
const guard = (fn) => async () => { const s = await boot(...fn.pre?.() ?? []); try { await fn(s); } finally { s.close(); } };

test('inventory: list with values hidden from managers, add item with opening stock, edit', async () => {
  const s = await boot([
    [/FROM products p LEFT JOIN product_categories/, () => R([{ id: 1, sku: 'GEL', name: 'Gel', unit: 'bottle', category: 'Gel', purchase_cost: '200', on_hand: '3', avg_cost: '210', min_level: '5' }, { id: 2, sku: 'PAD', name: 'Pads', unit: 'pack', category: null, purchase_cost: '50', on_hand: '40', avg_cost: '0', min_level: '0' }])],
    [/FROM product_categories ORDER/, () => R([{ code: 'GEL', name: 'Gel' }])],
    [/SELECT 1 FROM products WHERE sku/, (p) => R(p[0] === 'BRAIDS-PACK' ? [{}] : [])],
    [/INSERT INTO products/, () => R([{ id: 9 }])],
    [/INSERT INTO inventory_transactions/, () => R([{ id: 1 }])],
    [/FROM inventory WHERE product_id/, () => R([{ qty_on_hand: '0' }])],
    [/UPDATE products SET/, () => R([{ id: 1 }])],
  ]);
  try {
    assert.equal((await s.call('GET', '/products?branchId=1', { as: as.technician })).status, 403);
    assert.equal((await s.call('GET', '/products', { as: as.owner })).status, 200);                                   // single-branch users default to their branch
    const o = await s.call('GET', '/products?branchId=1', { as: as.owner });
    assert.deepEqual(o.json.rows.map((x) => [x.name, x.onHand, x.unitCost, x.value, x.low]), [['Gel', 3, 210, 630, true], ['Pads', 40, 50, 2000, false]]);
    const m = await s.call('GET', '/products?branchId=1', { as: as.manager }); assert.equal(m.json.rows[0].value, null); assert.equal(m.json.canManage, true);
    assert.equal((await s.call('POST', '/products', { as: as.receptionist, body: { name: 'X', branchId: 1 } })).status, 403);
    const c = await s.call('POST', '/products', { as: as.owner, body: { name: 'Braids pack', branchId: 1, purchaseCost: 150, minLevel: 10, openingQty: 40 } });
    assert.equal(c.status, 201); assert.equal(c.json.sku, 'BRAIDS-PACK-2');
    const ledger = s.db.log.find((x) => /INSERT INTO inventory_transactions/.test(x.sql)); assert.equal(ledger.params[2], 'purchase'); assert.equal(ledger.params[3], 40);
    assert.equal((await s.call('POST', '/products', { as: as.owner, body: { name: '', branchId: 1 } })).status, 422);
    assert.equal((await s.call('PUT', '/products/1', { as: as.owner, body: { branchId: 1, minLevel: 8, purchaseCost: 220 } })).status, 200);
  } finally { s.close(); }
});

test('expenses: list totals by category, record, delete needs a reason', async () => {
  const s = await boot([
    [/FROM expenses e LEFT JOIN users/, () => R([{ id: 1, date: '2026-10-02', category: 'rent', amount: '45000', description: null, reference: null, by: 'Owner' }, { id: 2, date: '2026-10-03', category: 'rent', amount: '1000', description: 'x', reference: 'r', by: 'Owner' }, { id: 3, date: '2026-10-03', category: 'marketing', amount: '500', description: null, reference: null, by: null }])],
    [/INSERT INTO expenses/, () => R([{ id: 8 }])],
    [/DELETE FROM expenses/, () => R([{ id: 1 }])],
  ]);
  try {
    assert.equal((await s.call('GET', '/expenses?from=2026-10-01&to=2026-10-31', { as: as.receptionist })).status, 403);
    const l = await s.call('GET', '/expenses?from=2026-10-01&to=2026-10-31', { as: as.manager });
    assert.equal(l.json.total, 46500); assert.deepEqual(l.json.byCategory, { rent: 46000, marketing: 500 }); assert.equal(l.json.canManage, false);
    assert.equal((await s.call('POST', '/expenses', { as: as.manager, body: { branchId: 1, category: 'rent', amount: 5, date: '2026-10-01' } })).status, 403);
    assert.equal((await s.call('POST', '/expenses', { as: as.owner, body: { branchId: 1, category: 'rent', amount: 0, date: '2026-10-01' } })).status, 422);
    assert.equal((await s.call('POST', '/expenses', { as: as.owner, body: { branchId: 1, category: 'fun', amount: 5, date: '2026-10-01' } })).status, 422);
    assert.equal((await s.call('POST', '/expenses', { as: as.owner, body: { branchId: 1, category: 'rent', amount: 5, date: 'soon' } })).status, 422);
    assert.equal((await s.call('POST', '/expenses', { as: as.owner, body: { branchId: 1, category: 'rent', amount: 45000, date: '2026-10-01', description: 'October rent' } })).status, 201);
    assert.equal((await s.call('DELETE', '/expenses/1', { as: as.owner })).status, 422);
    assert.equal((await s.call('DELETE', '/expenses/1?reason=entered%20twice', { as: as.owner })).status, 200);
  } finally { s.close(); }
});

test('customers: list/search, profile, create, edit, notes; permissions', async () => {
  const s = await boot([
    [/FROM v_customer_metrics WHERE \(/, () => R([{ customer_id: 1, full_name: 'Jane', phone: '0712345678', visits: 4, total_spend: '8000', avg_spend_per_visit: '2000', last_visit: '2026-10-01', next_visit: '2026-10-29', status: 'active', marketing_consent: true, days_since_last_visit: 13 }])],
    [/SELECT \* FROM v_customer_metrics WHERE customer_id/, (p) => p[0] === 99 ? R() : R([{ full_name: 'Jane', phone: '0712345678', status: 'vip', marketing_consent: true, visits: 12, total_spend: '60000', avg_spend_per_visit: '5000', services_purchased: 20, days_since_last_visit: 3, avg_days_between: '14.4', last_visit: '2026-10-11', expected_next_visit: '2026-10-25' }])],
    [/FROM transactions t WHERE t.customer_id/, () => R([{ date: '2026-10-11', receipt_no: 'M-1', total: '1800', services: 'Gel, Braids' }])],
    [/GROUP BY ti.description/, () => R([{ name: 'Gel Polish', n: 9 }])],
    [/GROUP BY tech.display_name/, () => R([{ name: 'Alice', n: 7 }])],
    [/FROM customer_notes n/, () => R([{ note: 'Allergic to latex', created_at: '2026-10-01T10:00:00Z', by: 'Rita' }])],
    [/SELECT allergies/, () => R([{ allergies: 'latex', birthday: '1994-05-02' }])],
    [/SELECT id FROM customers WHERE phone_normalized/, (p) => R(p[0] === '0700000000' ? [{ id: 5 }] : [])],
    [/INSERT INTO customers/, () => R([{ id: 11 }])],
    [/UPDATE customers SET/, (p) => R(p[0] === 99 ? [] : [{ id: p[0] }])],
  ]);
  try {
    assert.equal((await s.call('GET', '/customer-list', { as: as.technician })).status, 403);
    const l = await s.call('GET', '/customer-list?q=jane&status=active', { as: as.receptionist }); assert.equal(l.status, 200); assert.equal(l.json.rows[0].spend, 8000); assert.equal(l.json.rows[0].status, 'active');
    assert.deepEqual(s.db.log.at(-1).params, ['jane', '', 'active']);
    s.db.log.length = 0; await s.call('GET', '/customer-list?q=0712%20345', { as: as.owner }); assert.deepEqual(s.db.log.at(-1).params, ['0712 345', '0712345', null]);
    const p = await s.call('GET', '/customers/1', { as: as.manager });
    assert.equal(p.status, 200); assert.equal(p.json.status, 'vip'); assert.equal(p.json.avgDaysBetween, 14); assert.equal(p.json.topService, 'Gel Polish'); assert.equal(p.json.preferredTechnician, 'Alice');
    assert.equal(p.json.history[0].services, 'Gel, Braids'); assert.equal(p.json.notes[0].note, 'Allergic to latex'); assert.equal(p.json.allergies, 'latex'); assert.equal(p.json.canManage, true);
    assert.equal((await s.call('GET', '/customers/99', { as: as.owner })).status, 404);
    assert.equal((await s.call('POST', '/customers', { as: as.owner, body: { fullName: 'New One', phone: '0700000000' } })).status, 409);
    assert.equal((await s.call('POST', '/customers', { as: as.receptionist, body: { fullName: 'New One', phone: '0711000000', consent: true } })).status, 201);
    assert.equal((await s.call('POST', '/customers', { as: as.receptionist, body: { fullName: ' ' } })).status, 422);
    assert.equal((await s.call('POST', '/customers', { as: as.receptionist, body: { fullName: 'B Day', phone: '0711000001', birthday: '2999-01-01' } })).status, 422);
    assert.equal((await s.call('POST', '/customers', { as: as.receptionist, body: { fullName: 'B Day', phone: '0711000001', birthday: 'abc' } })).status, 422);
    s.db.log.length = 0;
    assert.equal((await s.call('POST', '/customers', { as: as.receptionist, body: { fullName: 'B Day', phone: '0711000001', birthday: '1992-03-14' } })).status, 201);
    assert.equal(s.db.log.find((l) => /INSERT INTO customers/.test(l.sql)).params.at(-1), '1992-03-14');
    assert.equal((await s.call('PUT', '/customers/1', { as: as.receptionist, body: { birthday: '1992-13-45' } })).status, 422);
    assert.equal((await s.call('PUT', '/customers/1', { as: as.receptionist, body: { phone: '0722000000', consent: false } })).status, 200);
    assert.equal((await s.call('PUT', '/customers/99', { as: as.receptionist, body: { fullName: 'Z' } })).status, 404);
    assert.equal((await s.call('PUT', '/customers/1', { as: as.technician, body: { fullName: 'Z' } })).status, 403);
    assert.equal((await s.call('POST', '/customers/1/notes', { as: as.receptionist, body: { note: ' ' } })).status, 422);
    assert.equal((await s.call('POST', '/customers/1/notes', { as: as.receptionist, body: { note: 'Prefers Alice' } })).status, 201);
  } finally { s.close(); }
});

test('appointments: list scoped to the technician, book with services, double booking refused, status changes', async () => {
  let clash = false;
  const s = await boot([
    [/FROM appointments a JOIN customers c/, (p) => R([{ id: 1, starts_at: '2026-10-16T07:00:00Z', minutes: 90, status: 'booked', notes: null, deposit_amount: '200', customer_id: 1, customer: 'Jane', phone: '0712345678', technician_id: 5, technician: 'Alice', services: [{ id: 1, name: 'Gel' }] }])],
    [/FROM services WHERE id = ANY/, () => R([{ id: 1, standard_price: '400', duration_minutes: 45 }, { id: 2, standard_price: '1400', duration_minutes: 180 }])],
    [/INSERT INTO appointments/, () => { if (clash) { const e = new Error('conflicting key'); e.code = '23P01'; throw e; } return R([{ id: 31 }]); }],
    [/UPDATE appointments SET status/, (p) => R(p[0] === 99 ? [] : [{ id: p[0] }])],
  ]);
  try {
    const t = await s.call('GET', '/appointments?from=2026-10-16&to=2026-10-16', { as: as.technician }); assert.equal(t.status, 200);
    assert.equal(s.db.log.at(-1).params[3], 7); assert.equal(t.json.rows[0].phone, null);
    const o = await s.call('GET', '/appointments?from=2026-10-16&to=2026-10-16', { as: as.receptionist }); assert.equal(s.db.log.at(-1).params[3], null); assert.equal(o.json.rows[0].phone, '0712345678'); assert.equal(o.json.rows[0].services[0].name, 'Gel');
    const body = { branchId: 1, customerId: 1, technicianId: 5, startsAt: '2026-10-16T10:00:00+03:00', serviceIds: [1, 2], deposit: 200 };
    assert.equal((await s.call('POST', '/appointments', { as: as.technician, body })).status, 403);
    assert.equal((await s.call('POST', '/appointments', { as: as.receptionist, body: { ...body, startsAt: 'tomorrow-ish' } })).status, 422);
    const ok = await s.call('POST', '/appointments', { as: as.receptionist, body }); assert.equal(ok.status, 201); assert.equal(ok.json.id, 31);
    const ins = s.db.log.find((x) => /INSERT INTO appointments/.test(x.sql)); assert.equal(ins.params[4], 225); assert.equal(ins.params[8], 'deposit_paid');          // 45 + 180 minutes
    assert.equal(s.db.log.filter((x) => /INSERT INTO appointment_services/.test(x.sql)).length, 2);
    clash = true; const c = await s.call('POST', '/appointments', { as: as.receptionist, body }); assert.equal(c.status, 409); assert.equal(c.json.error.code, 'DOUBLE_BOOKED');
    assert.equal((await s.call('PUT', '/appointments/1/status', { as: as.receptionist, body: { status: 'confirmed' } })).status, 200);
    assert.equal((await s.call('PUT', '/appointments/1/status', { as: as.receptionist, body: { status: 'whenever' } })).status, 422);
    assert.equal((await s.call('PUT', '/appointments/99/status', { as: as.receptionist, body: { status: 'cancelled' } })).status, 404);
  } finally { s.close(); }
});
