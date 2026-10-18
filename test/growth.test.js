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


test('due list: needs customers.view, rejects unknown status, shapes rows', async () => {
  const s = await boot([
    [/FROM v_customer_metrics m\s+WHERE m.lifecycle_status = ANY/, () => R([{ customer_id: 4, full_name: 'Jane Wanjiku', phone: '0712345678', lifecycle_status: 'due', status: 'vip', visits: 5, total_spend: '9000', last_visit: '2026-08-01', expected_next: '2026-09-01', days_since_last_visit: 75, marketing_consent: true, opted_out_at: null, contacted_at: null }])],
    [/GROUP BY m.lifecycle_status/, () => R([{ s: 'due', n: '3' }, { s: 'at_risk', n: '2' }])],
    [/INSERT INTO customer_notes/, () => R([{}])],
  ]);
  try {
    assert.equal((await s.call('GET', '/customers/due', { as: as.technician })).status, 403);
    assert.equal((await s.call('GET', '/customers/due?statuses=bogus', { as: as.receptionist })).status, 422);
    const r = await s.call('GET', '/customers/due', { as: as.receptionist });
    assert.equal(r.status, 200); assert.deepEqual(r.json.counts, { due: 3, at_risk: 2, lapsed: 0, win_back: 0 });
    assert.deepEqual([r.json.rows[0].name, r.json.rows[0].vip, r.json.rows[0].consent], ['Jane Wanjiku', true, true]);
    assert.equal((await s.call('POST', '/customers/4/contacted', { as: as.receptionist, body: { channel: 'whatsapp' } })).status, 201);
    assert.equal(s.db.log.at(-1).params[1], 'Follow-up: contacted by whatsapp');
  } finally { s.close(); }
});

test('loyalty: sale awards points, void takes them back, redeem checks balance and minimum', async () => {
  let balance = 120;
  const s = await boot([
    [/SELECT rule_type, params FROM loyalty_rules/, () => R([{ rule_type: 'points_per_spend', params: { spend_per_point: 100 } }, { rule_type: 'points_per_visit', params: { points: 2 } }])],
    [/FROM app_settings WHERE branch_id IS NULL AND key IN/, () => R([{ key: 'loyalty.min_redeem', value: 50 }])],
    [/FROM transactions t JOIN customers c ON c.id = t.customer_id/, () => R([{ customer_id: 4, total: '1850', d: '2026-10-15', birthday: null }])],
    [/SELECT id, points_balance, lifetime_points FROM loyalty_accounts WHERE customer_id/, () => R([{ id: 8, points_balance: balance, lifetime_points: 300 }])],
    [/FROM loyalty_transactions lt WHERE lt.transaction_id/, () => R([{ account_id: 8, pts: '20' }])],
  ]);
  s.db.checkoutStub = true;
  try {
    const { awardForSale, reverseForSale } = await import('../src/api/growth.js');
    await awardForSale(s.db, 55);
    const ins = s.db.log.find((l) => /INSERT INTO loyalty_transactions/.test(l.sql));
    assert.deepEqual([ins.params[1], ins.params[2]], [20, 'Sale: 18 for spend + 2 for the visit']);
    await reverseForSale(s.db, 55);
    assert.equal(s.db.log.filter((l) => /INSERT INTO loyalty_transactions/.test(l.sql)).at(-1).params[1], -20);
    assert.equal((await s.call('POST', '/customers/4/loyalty/redeem', { as: as.receptionist, body: { points: 10 } })).status, 422);       // below the minimum of 50
    assert.equal((await s.call('POST', '/customers/4/loyalty/redeem', { as: as.receptionist, body: { points: 500 } })).status, 422);      // more than the balance
    const ok = await s.call('POST', '/customers/4/loyalty/redeem', { as: as.receptionist, body: { points: 100 } });
    assert.deepEqual([ok.status, ok.json.discountValue, ok.json.balance], [200, 100, 20]);
    assert.equal((await s.call('POST', '/customers/4/loyalty/adjust', { as: as.receptionist, body: { points: 5, reason: 'x' } })).status, 403);
    assert.equal((await s.call('PUT', '/loyalty/rules', { as: as.receptionist, body: { spendPerPoint: 50 } })).status, 403);
    assert.equal((await s.call('PUT', '/loyalty/rules', { as: as.manager, body: { spendPerPoint: 50, pointsPerVisit: 1, birthdayBonus: 20, pointValue: 1, minRedeem: 50 } })).status, 200);
  } finally { s.close(); }
});

test('campaigns: permissions, audience required, create builds recipients, rendered messages, opt-out', async () => {
  const s = await boot([
    [/SELECT COUNT\(\*\) AS n FROM v_customer_metrics m WHERE \(/, () => R([{ n: '4' }])],
    [/SELECT COUNT\(\*\) AS n FROM v_customer_metrics m\s+WHERE m.marketing_consent/, () => R([{ n: '6' }])],
    [/SELECT m.customer_id, m.full_name, m.phone, m.status FROM/, () => R([{ customer_id: 4, full_name: 'Jane Wanjiku', phone: '0712345678', status: 'lapsed' }])],
    [/INSERT INTO marketing_segments/, () => R([{ id: 3 }])],
    [/INSERT INTO marketing_campaigns/, () => R([{ id: 11 }])],
    [/INSERT INTO campaign_recipients/, () => R([], 6)],
    [/FROM marketing_campaigns WHERE id = \$1/, () => R([{ id: 11, name: 'Win back', channel: 'whatsapp', status: 'sending', message_template: 'Hi {name}, we miss you at {salon}!', attribution_window_days: 14 }])],
    [/FROM campaign_recipients r JOIN customers cu/, () => R([{ id: 1, customer_id: 4, phone: '0712345678', status: 'queued', sent_at: null, full_name: 'Jane Wanjiku' }])],
    [/FROM campaign_recipients WHERE id = \$1 AND campaign_id/, () => R([{ customer_id: 4, status: 'queued' }])],
    [/COUNT\(\*\) AS n FROM campaign_recipients WHERE campaign_id/, () => R([{ n: '0' }])],
  ]);
  try {
    const mk = { name: 'Win back', channel: 'whatsapp', message: 'Hi {name}, we miss you at {salon}!', statuses: ['lapsed', 'win_back'] };
    assert.equal((await s.call('POST', '/campaigns', { as: as.receptionist, body: mk })).status, 403);
    assert.equal((await s.call('POST', '/campaigns', { as: as.manager, body: { ...mk, statuses: [] } })).status, 422);
    assert.equal((await s.call('POST', '/campaigns', { as: as.manager, body: { ...mk, statuses: ['nope'] } })).status, 422);
    const a = await s.call('POST', '/campaigns/audience', { as: as.manager, body: { statuses: ['lapsed'] } });
    assert.deepEqual([a.status, a.json.count], [200, 6]);
    const c = await s.call('POST', '/campaigns', { as: as.manager, body: mk });
    assert.deepEqual([c.status, c.json], [201, { id: 11, recipients: 6 }]);
    const d = await s.call('GET', '/campaigns/11', { as: as.manager });
    assert.equal(d.json.recipients[0].message, 'Hi Jane, we miss you at Cute Nails & Salons Kenya!');
    assert.equal((await s.call('POST', '/campaigns/11/recipients/1/sent', { as: as.manager })).status, 200);
    assert.equal((await s.call('POST', '/campaigns/11/recipients/1/opted-out', { as: as.manager })).status, 200);
    assert.ok(s.db.log.some((l) => /UPDATE customers SET marketing_consent = false/.test(l.sql)));
    assert.equal((await s.call('GET', '/campaigns', { as: as.receptionist })).status, 403);
  } finally { s.close(); }
});
