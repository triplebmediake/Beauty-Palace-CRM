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


test('settings: public branding, owner-only edit, validation, saved as rows', async () => {
  const s = await boot([
    [/FROM app_settings WHERE \(branch_id IS NULL OR branch_id = \$1\) AND \(key LIKE/, () => R([{ key: 'business.name', value: 'Cute Nails Main' }, { key: 'business.phone', value: '0700111222' }, { key: 'status.lapsed_days', value: 60 }])],
  ]);
  try {
    const b = await s.call('GET', '/branding');                                                   // no sign-in needed
    assert.deepEqual([b.status, b.json.name], [200, 'Cute Nails Main']);
    assert.equal((await s.call('GET', '/settings/business', { as: as.manager })).status, 403);
    const g = await s.call('GET', '/settings/business', { as: as.owner });
    assert.deepEqual([g.status, g.json.phone, g.json.hours.sun.closed, g.json.rules.winbackDays], [200, '0700111222', true, 90]);
    const put = (body, who = as.owner) => s.call('PUT', '/settings/business', { as: who, body });
    assert.equal((await put({ name: 'X' }, as.manager)).status, 403);
    assert.equal((await put({ name: '  ' })).status, 422);
    assert.equal((await put({ email: 'nope' })).status, 422);
    assert.equal((await put({ logo: 'data:image/svg+xml;base64,AAAA' })).status, 422);
    assert.equal((await put({ logo: 'data:image/png;base64,' + 'A'.repeat(500000) })).status, 422);
    assert.equal((await put({ hours: { mon: { open: '09:00', close: '08:00' } } })).status, 422);
    assert.equal((await put({ rules: { lapsedDays: 100 } })).status, 422);                      // would pass win-back (90)
    assert.equal((await put({})).status, 422);
    const ok = await put({ name: 'Cute Nails Main', tagline: 'Beauty', logo: 'data:image/png;base64,iVBORw0KGgo=', rules: { lapsedDays: 45 } });
    assert.equal(ok.status, 200);
    const saved = s.db.log.filter((l) => /INSERT INTO app_settings/.test(l.sql)).map((l) => l.params[0]);
    assert.deepEqual(saved.sort(), ['business.logo', 'business.name', 'business.tagline', 'status.lapsed_days']);
  } finally { s.close(); }
});

test('appointments must fall inside opening hours (Nairobi time)', async () => {
  const { checkOpeningHours, loadBusiness } = await import('../src/api/settings.js');
  const hours = (await loadBusiness({ query: async () => R() })).hours;                           // defaults: Mon-Sat 08:00-20:00, Sunday closed
  const code = (iso, mins) => { try { checkOpeningHours(hours, new Date(iso), mins); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code('2026-10-16T10:00:00+03:00', 90), 'ok');            // Friday morning
  assert.equal(code('2026-10-16T08:00:00+03:00', 60), 'ok');            // exactly at opening
  assert.equal(code('2026-10-16T19:00:00+03:00', 60), 'ok');            // ends exactly at closing
  assert.equal(code('2026-10-16T07:30:00+03:00', 30), 'OUTSIDE_HOURS'); // before opening
  assert.equal(code('2026-10-16T19:30:00+03:00', 60), 'OUTSIDE_HOURS'); // would end after closing
  assert.equal(code('2026-10-16T21:00:00+03:00', 30), 'OUTSIDE_HOURS'); // evening
  assert.equal(code('2026-10-18T10:00:00+03:00', 60), 'CLOSED');        // Sunday
  assert.equal(code('2026-10-16T22:00:00Z', 30), 'OUTSIDE_HOURS');       // 01:00 Saturday in Nairobi
});

test('only the owner can override opening hours, and the booking is marked', async () => {
  const s = await boot([
    [/FROM services WHERE id = ANY/, () => R([{ id: 1, standard_price: '400', duration_minutes: 45 }])],
    [/INSERT INTO appointments/, () => R([{ id: 31 }])],
  ]);
  try {
    const body = { branchId: 1, customerId: 1, serviceIds: [1], startsAt: '2026-10-16T21:00:00+03:00', notes: 'Bride' };      // Friday 21:00 is after closing
    assert.equal((await s.call('POST', '/appointments', { as: as.manager, body })).status, 422);
    assert.equal((await s.call('POST', '/appointments', { as: as.manager, body: { ...body, overrideHours: true } })).status, 422);   // managers cannot override
    assert.equal((await s.call('POST', '/appointments', { as: as.owner, body })).status, 422);                                   // owner must ask for it
    const ok = await s.call('POST', '/appointments', { as: as.owner, body: { ...body, overrideHours: true } });
    assert.equal(ok.status, 201);
    const ins = s.db.log.find((l) => /INSERT INTO appointments/.test(l.sql));
    assert.match(ins.params[6], /^\[Booked outside opening hours by .+\] Bride$/);
  } finally { s.close(); }
});

test('services: add and edit need services.manage; price change needs pricing.manage and a reason; duplicates refused', async () => {
  let dup = false;
  const s = await boot([
    [/SELECT id FROM service_categories WHERE code/, (p) => R(p[0] === 'NAILS' || p[0] === 'HAIR' ? [{ id: 3 }] : [])],
    [/SELECT 1 FROM services WHERE category_id/, () => R(dup ? [{}] : [])],
    [/SELECT 1 FROM services WHERE code/, (p) => R(p[0] === 'NAILS-ACRYLIC-REFILL' ? [{}] : [])],
    [/INSERT INTO services/, () => R([{ id: 77 }])],
    [/UPDATE services SET/, () => R([{ id: 5 }])],
    [/FROM service_categories ORDER BY name/, () => R([{ code: 'NAILS', name: 'Nails' }])],
  ]);
  try {
    const add = (body, who = as.owner) => s.call('POST', '/services', { as: who, body });
    const good = { name: 'Acrylic Refill', category: 'nails', price: 900, minutes: 60 };
    assert.equal((await add(good, as.manager)).status, 403);
    assert.equal((await add({ ...good, category: 'zzz' })).status, 422);
    assert.equal((await add({ ...good, price: -5 })).status, 422);
    assert.equal((await add({ ...good, minutes: 1 })).status, 422);
    const ok = await add(good);
    assert.deepEqual([ok.status, ok.json.code], [201, 'NAILS-ACRYLIC-REFILL-2']);                  // first code was taken
    dup = true; assert.equal((await add(good)).status, 409); dup = false;
    const put = (body, who = as.owner) => s.call('PUT', '/services/5', { as: who, body });
    assert.equal((await put({ name: 'X' }, as.manager)).status, 403);
    assert.equal((await put({ price: 500 })).status, 422);                                           // price change needs a reason
    assert.equal((await put({})).status, 422);
    assert.equal((await put({ price: 500, reason: 'New price list' })).status, 200);
    const upd = s.db.log.filter((l) => /UPDATE services SET/.test(l.sql)).at(-1);
    assert.match(upd.sql, /standard_price = \$2/);
    assert.equal((await put({ active: false, name: 'Old name', minutes: 45, category: 'HAIR' })).status, 200);
    const g = await s.call('GET', '/services', { as: as.owner });
    assert.deepEqual([g.json.canManage, g.json.canPrice, g.json.categories.length], [true, true, 1]);
  } finally { s.close(); }
});

test('services list: resolved commission per service, hidden without commission permission', async () => {
  const rules = [
    { id: 1, scope: 'default', category_id: null, service_id: null, calc_type: 'percent_of_price', rate: 0.4, fixed_amount: null, effective_from: '2020-01-01', effective_to: null },
    { id: 2, scope: 'category', category_id: 2, service_id: null, calc_type: 'percent_after_materials', rate: 0.5, fixed_amount: null, effective_from: '2020-01-01', effective_to: null },
    { id: 3, scope: 'service', category_id: null, service_id: 11, calc_type: 'percent_of_price', rate: 0.3, fixed_amount: null, effective_from: '2020-01-01', effective_to: null },
  ];
  const s = await boot([
    [/FROM services s JOIN service_categories/, () => R([
      { id: 10, code: 'N1', name: 'Gel', category_id: 1, category: 'NAILS', standard_price: '1000', duration_minutes: 60, is_active: true },
      { id: 11, code: 'H1', name: 'Braids', category_id: 2, category: 'HAIR', standard_price: '3000', duration_minutes: 180, is_active: true },
      { id: 12, code: 'H2', name: 'Wash', category_id: 2, category: 'HAIR', standard_price: '500', duration_minutes: 30, is_active: true }])],
    [/FROM service_categories ORDER BY name/, () => R([{ id: 1, code: 'NAILS', name: 'Nails' }, { id: 2, code: 'HAIR', name: 'Hair' }])],
    [/FROM commission_rules WHERE is_active AND scope IN/, () => R(rules)],
  ]);
  try {
    const g = await s.call('GET', '/services', { as: as.owner });
    const by = Object.fromEntries(g.json.rows.map((r) => [r.id, r]));
    assert.deepEqual([by[10].commission.source, by[10].commission.rate, by[10].needsMaterials], ['default', 0.4, false]);
    assert.deepEqual([by[11].commission.source, by[11].commission.rate, by[11].needsMaterials], ['service', 0.3, false]);
    assert.deepEqual([by[12].commission.source, by[12].needsMaterials], ['category', true]);
    assert.equal(g.json.categories[1].commission.calcType, 'percent_after_materials');
    assert.equal(g.json.canCommission, true);
    const r = await s.call('GET', '/services', { as: as.receptionist });
    assert.equal(r.status, 200);
    assert.equal(r.json.rows[0].commission, undefined);
    assert.equal(r.json.categories[0].commission, undefined);
  } finally { s.close(); }
});

test('commission rules: same-day correction updates in place; clear reverts a service to its category', async () => {
  let same = true;
  const s = await boot([[/AND effective_from = \$5::date/, () => R(same ? [{ id: 9 }] : [])], [/INSERT INTO commission_rules/, () => R([{ id: 50 }])]]);
  try {
    const body = { scope: 'service', serviceId: 11, calcType: 'percent_of_price', rate: 0.35, effectiveFrom: '2026-10-15', reason: 'Fix' };
    assert.equal((await s.call('POST', '/commission-rules', { as: as.receptionist, body })).status, 403);
    assert.equal((await s.call('POST', '/commission-rules', { as: as.owner, body })).status, 201);
    assert.ok(s.db.log.some((l) => /UPDATE commission_rules SET calc_type/.test(l.sql)));
    assert.ok(!s.db.log.some((l) => /INSERT INTO commission_rules/.test(l.sql)));
    same = false;
    assert.equal((await s.call('POST', '/commission-rules', { as: as.owner, body })).status, 201);
    assert.ok(s.db.log.some((l) => /INSERT INTO commission_rules/.test(l.sql)));
    const c = { serviceId: 11, effectiveFrom: '2026-10-15', reason: 'Back to category' };
    assert.equal((await s.call('POST', '/commission-rules/clear', { as: as.receptionist, body: c })).status, 403);
    assert.equal((await s.call('POST', '/commission-rules/clear', { as: as.owner, body: c })).status, 200);
    assert.equal((await s.call('POST', '/commission-rules/clear', { as: as.owner, body: { ...c, reason: '' } })).status, 422);
  } finally { s.close(); }
});

test('commission lines + payslip + csv exports: scoping, permissions, totals net of voids', async () => {
  const line = (o) => ({ id: 1, date: '2026-10-03', receipt_no: 'CNS-2026-000001', service: 'Builder gel', technician: 'Amina', technician_id: 7, branch: 'Main', service_price: '1200', material_cost: '0', commissionable_amount: '1200', rate: 0.4, calc_type: 'percent_of_price', commission_amount: '480', status: 'paid', approved_at: '2026-10-05 10:00', paid_at: '2026-10-06 10:00', pay_method: 'mpesa', pay_reference: 'QX1', reverses_id: null, ...o });
  const s = await boot([
    [/FROM commission_calculations cc\s+JOIN transactions/, () => R([line({}), line({ id: 2, service: 'Massage', service_price: '3000', commissionable_amount: '3000', commission_amount: '1200', status: 'approved', paid_at: null, pay_method: null, pay_reference: null }),
      line({ id: 3, status: 'pending', commission_amount: '-480', reverses_id: 1, paid_at: null, pay_method: null, pay_reference: null })])],
    [/FROM technicians t LEFT JOIN service_categories sc/, () => R([{ display_name: 'Amina', specialty: 'NAILS' }])],
  ]);
  try {
    const q = '?from=2026-10-03&to=2026-10-09&technicianId=7';
    const p = await s.call('GET', '/commissions/payslip' + q, { as: as.owner });
    assert.equal(p.status, 200);
    assert.deepEqual([p.json.technician, p.json.specialty, p.json.services, p.json.sales, p.json.total, p.json.paid, p.json.balance, p.json.pending, p.json.approved], ['Amina', 'NAILS', 1, 3000, 1200, 480, 720, -480, 1200]);
    assert.equal((await s.call('GET', '/commissions/payslip' + q, { as: as.receptionist })).status, 403);
    assert.equal((await s.call('GET', '/commissions/payslip' + q, { as: as.technician })).status, 200);       // own payslip only (scoped to their technician id)
    s.db.log.length = 0;
    await s.call('GET', '/commissions/payslip' + q, { as: as.technician });
    assert.equal(s.db.log.find((l) => /FROM commission_calculations cc/.test(l.sql)).params[3], 7);
    const l = await s.call('GET', '/commissions/lines?from=2026-10-03&to=2026-10-09&status=approved', { as: as.owner });
    assert.equal(l.status, 200);
    assert.equal(s.db.log.filter((x) => /FROM commission_calculations cc/.test(x.sql)).at(-1).params[4], 'approved');
    assert.equal((await s.call('GET', '/commissions/lines?from=2026-10-03&to=2026-10-09&status=bogus', { as: as.owner })).status, 422);
    assert.equal((await s.call('GET', '/commissions/lines?from=2026-10-03&to=2026-10-09&format=csv', { as: as.technician })).status, 403);   // no export permission
    const ok = await s.call('GET', '/commissions/lines?from=2026-10-03&to=2026-10-09&format=csv', { as: as.owner });
    assert.equal(ok.status, 200);
  } finally { s.close(); }
});

test('staff profiles: permissions, validation, lifetime stats, absences, commission phone', async () => {
  const s = await boot([
    [/FROM technicians t JOIN branches b ON b.id = t.branch_id LEFT JOIN service_categories sc ON sc.id = t.specialty_category_id\s+WHERE t.id/, () => R([{ id: 7, display_name: 'Amina', phone: '0712345678', email: null, branch_id: 1, branch: 'Main', specialty: 'NAILS', is_active: true, hired_on: '2025-01-05', national_id: '12345678', has_photo: true }])],
    [/COALESCE\(SUM\(cr.amount\),0\) AS sales/, () => R([{ sales: '250000', services: 200, customers: 120, visits: 150, first_sale: '2025-01-06', last_sale: '2026-10-14' }])],
    [/GROUP BY cr.description/, () => R([{ service: 'Gel Polish', times: 80, revenue: '32000' }])],
    [/FROM staff_absences a LEFT JOIN users/, () => R([{ id: 3, date: '2026-10-01', kind: 'sick', reason: 'Malaria', by: 'Owner' }])],
    [/COUNT\(\*\) FILTER \(WHERE kind/, () => R([{ d90: 2, year: 4 }])],
    [/SELECT 1 FROM technicians WHERE id/, () => R([{}])],
    [/SELECT 1 FROM staff_absences WHERE technician_id/, () => R([])],
    [/INSERT INTO staff_absences/, () => R([{ id: 9 }])],
    [/UPDATE technicians SET/, () => R([{ id: 7 }])],
    [/SELECT id_photo FROM technicians/, () => R([{ id_photo: 'data:image/png;base64,AAAA' }])],
    [/FROM commission_calculations cc JOIN technicians/, () => R([{ technician: 'Amina', phone: '0712345678', technician_id: 7, total: '100', pending: '0', approved: '100', paid: '0' }])],
  ]);
  try {
    const g = await s.call('GET', '/staff/7', { as: as.manager });
    assert.equal(g.status, 200);
    assert.deepEqual([g.json.lifetime.sales, g.json.lifetime.customers, g.json.lifetime.since, g.json.topServices[0].service, g.json.absencesLast90, g.json.nationalId, g.json.hasIdPhoto], [250000, 120, '2025-01-05', 'Gel Polish', 2, '12345678', true]);
    assert.equal((await s.call('GET', '/staff/7', { as: as.receptionist })).status, 403);
    assert.equal((await s.call('GET', '/staff/7/id-photo', { as: as.manager })).json.photo.startsWith('data:image'), true);
    assert.equal((await s.call('GET', '/staff/7/id-photo', { as: as.receptionist })).status, 403);
    const put = (body, who = as.owner) => s.call('PUT', '/staff/7', { as: who, body });
    assert.equal((await put({ phone: '0712 345 678', email: 'a@b.co', nationalId: '12345678', hiredOn: '2025-01-05' })).status, 200);
    assert.equal((await put({ phone: 'abc' })).status, 422);
    assert.equal((await put({ email: 'nope' })).status, 422);
    assert.equal((await put({ hiredOn: '2999-01-01' })).status, 422);
    assert.equal((await put({ idPhoto: 'javascript:alert(1)' })).status, 422);
    assert.equal((await put({ idPhoto: 'data:image/png;base64,' + 'A'.repeat(800000) })).status, 422);
    assert.equal((await put({ idPhoto: 'data:image/png;base64,iVBORw0KGgo=' })).status, 200);
    assert.equal((await put({})).status, 422);
    assert.equal((await put({ phone: '0700000000' }, as.receptionist)).status, 403);
    const ab = (body, who = as.owner) => s.call('POST', '/staff/7/absences', { as: who, body });
    assert.equal((await ab({ date: '2026-10-01', kind: 'sick' })).status, 201);
    assert.equal((await ab({ date: '2999-01-01', kind: 'sick' })).status, 422);
    assert.equal((await ab({ date: '2026-10-01', kind: 'nap' })).status, 422);
    assert.equal((await ab({ date: '2026-10-01', kind: 'sick' }, as.receptionist)).status, 403);
    assert.equal((await s.call('GET', '/commissions/summary?from=2026-10-03&to=2026-10-09', { as: as.owner })).json.rows[0].phone, '0712345678');
  } finally { s.close(); }
});

test('branch settings: a branch overrides only what it fills in; blank or default values mean "follow the default"; rules stay global', async () => {
  const rows = [{ key: 'business.name', value: 'Cute Nails', branch_id: null }, { key: 'business.phone', value: '0700', branch_id: null }, { key: 'business.address', value: 'Main St', branch_id: null },
    { key: 'business.name', value: 'Beauty Palace', branch_id: 2 }, { key: 'business.phone', value: '', branch_id: 2 }];
  const s = await boot([
    [/FROM app_settings WHERE \(branch_id IS NULL OR branch_id = \$1\)/, (p) => R(rows.filter((r) => r.branch_id == null || r.branch_id === p[0]))],
    [/SELECT 1 FROM branches WHERE id/, () => R([{}])],
    [/FROM app_settings WHERE branch_id IS NULL AND key LIKE 'business/, () => R([{ key: 'business.phone', value: '0700' }, { key: 'business.address', value: 'Main St' }])],
  ]);
  try {
    const g = await s.call('GET', '/settings/business?branchId=2', { as: as.owner });
    assert.deepEqual([g.json.name, g.json.phone, g.json.address, g.json.overridden], ['Beauty Palace', '0700', 'Main St', ['business.name']]);   // blank override ignored
    assert.equal((await s.call('GET', '/branding?branchId=2')).json.name, 'Beauty Palace');
    assert.equal((await s.call('GET', '/branding')).json.name, 'Cute Nails');
    s.db.log.length = 0;
    const put = (body, who = as.admin) => s.call('PUT', '/settings/business', { as: who, body });
    assert.equal((await put({ branchId: 2, phone: '0711', address: 'Main St', tagline: '' })).status, 200);
    const sql = s.db.log.map((l) => l.sql);
    assert.equal(sql.filter((q) => /^INSERT INTO app_settings/.test(q)).length, 1);                       // phone differs -> override saved
    assert.equal(sql.filter((q) => /^DELETE FROM app_settings WHERE branch_id/.test(q)).length, 2);       // address equals default, tagline blank -> no override
    assert.equal((await put({ branchId: 2, rules: { lapsedDays: 40 } })).status, 422);
    assert.equal((await put({ branchId: 2, phone: '0711' }, as.manager)).status, 403);
    assert.equal((await put({ branchId: 3, phone: '0711' }, as.owner)).status, 403);                  // owner not assigned to branch 3
  } finally { s.close(); }
});

test('service materials ("recipe"): list, replace, validate, permission', async () => {
  const s = await boot([
    [/FROM service_materials sm JOIN products p/, () => R([{ product_id: 5, name: 'Braids', unit: 'pack', default_qty: '2.000' }])],
    [/SELECT 1 FROM services WHERE id/, () => R([{}])],
    [/INSERT INTO service_materials/, () => R([], 1)],
  ]);
  try {
    const g = await s.call('GET', '/services/3/materials', { as: as.owner });
    assert.deepEqual(g.json.rows, [{ productId: 5, name: 'Braids', unit: 'pack', qty: 2 }]);
    assert.equal((await s.call('GET', '/services/3/materials', { as: as.technician })).status, 403);
    const put = (materials, who = as.owner) => s.call('PUT', '/services/3/materials', { as: who, body: { materials } });
    s.db.log.length = 0;
    assert.equal((await put([{ productId: 5, qty: 2 }, { productId: 6, qty: 0.5 }])).status, 200);
    const q = s.db.log.map((l) => l.sql);
    assert.equal(q.filter((x) => /^DELETE FROM service_materials/.test(x)).length, 1);
    assert.equal(q.filter((x) => /^INSERT INTO service_materials/.test(x)).length, 2);
    assert.equal((await put([{ productId: 5, qty: 0 }])).status, 422);
    assert.equal((await put([{ productId: 5, qty: 1 }, { productId: 5, qty: 2 }])).status, 422);
    assert.equal((await put([])).status, 200);                                                    // empty list = no stock used
    assert.equal((await put([{ productId: 5, qty: 1 }], as.receptionist)).status, 403);
  } finally { s.close(); }
});
