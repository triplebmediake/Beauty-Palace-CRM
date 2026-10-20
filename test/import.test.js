import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { readTable } from '../src/import/parse.js';
import { planImport } from '../src/import/plan.js';
import { parseDate, parseAmount, normPhone, parseMaterials, parseMethod } from '../src/import/normalize.js';
import { previewImport, commitImport, rollbackBatch } from '../src/import/run.js';
import { createApp } from '../src/http/app.js';
import { registerRoutes } from '../src/api/routes.js';
import { signToken } from '../src/auth/token.js';
import { ROLES } from '../src/auth/permissions.js';

const XLSX = fs.readFileSync(new URL('./fixtures/history.xlsx', import.meta.url));
const CSV = fs.readFileSync(new URL('./fixtures/history.csv', import.meta.url));

const rule = (o) => ({ is_active: true, effective_from: '2020-01-01', effective_to: null, ...o });
const REF = () => ({
  today: '2026-10-13',
  services: [{ id: 1, name: 'Gel Polish', code: 'GEL', category_id: 1 }, { id: 2, name: 'Acrylic Full Set', code: 'ACR', category_id: 1 }, { id: 3, name: 'Knotless Braids', code: 'KB', category_id: 2 }],
  technicians: [{ id: 10, display_name: 'Faith', branch_id: 1 }, { id: 11, display_name: 'Grace', branch_id: 1 }],
  branches: [{ id: 1, code: 'KIL', name: 'Kilimani' }], categories: [{ id: 1, code: 'NAILS' }, { id: 2, code: 'HAIR' }],
  products: [{ id: 50, sku: 'GEL1', name: 'Gel', unit_cost_cents: 20000 }, { id: 51, sku: 'BR', name: 'Braids', unit_cost_cents: 30000 }],
  byPhone: new Map([['254799999999', { id: 900, full_name: 'Sheila Njeri', phone_normalized: '254799999999' }]]),
  byName: new Map([['sheila njeri', [{ id: 900, full_name: 'Sheila Njeri', phone_normalized: '254799999999' }]]]),
  importKeys: new Set(), existingSales: new Set(),
  rules: [rule({ id: 1, scope: 'default', calc_type: 'percent_of_price', rate: 0.4 }), rule({ id: 2, scope: 'category', category_id: 2, calc_type: 'percent_after_materials', rate: 0.5 })],
});

test('normalizers: dates, amounts, phones, methods, materials', () => {
  assert.equal(parseDate('05/10/2026'), '2026-10-05');
  assert.equal(parseDate('05/10/2026', { dateFormat: 'mdy' }), '2026-05-10');
  assert.equal(parseDate('2026-10-05'), '2026-10-05');
  assert.equal(parseDate('46269'), '2026-09-04');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseAmount('Ksh 4,500'), 450000); assert.equal(parseAmount('1000/='), 100000); assert.equal(parseAmount('abc'), null);
  assert.equal(normPhone('0712 345 678'), '254712345678'); assert.equal(normPhone('+254712345678'), '254712345678'); assert.equal(normPhone('12345'), null);
  assert.equal(parseMethod('M-Pesa'), 'mpesa'); assert.equal(parseMethod('CASH'), 'cash'); assert.equal(parseMethod(''), null);
  assert.deepEqual(parseMaterials('Braids x2; Gel x1'), [{ name: 'Braids', qty: 2 }, { name: 'Gel', qty: 1 }]);
  assert.deepEqual(parseMaterials('2 packs braids'), [{ name: 'braids', qty: 2 }]);
});

test('the real .xlsx fixture is read: text, numbers and true Excel dates', () => {
  const t = readTable(XLSX, 'history.xlsx');
  assert.equal(t.headers[1], 'Customer Name'); assert.equal(t.rows.length, 11);
  assert.equal(t.rows[3].cells[0], '46269');                      // an Excel date cell arrives as its serial number
  assert.equal(parseDate(t.rows[3].cells[0]), '2026-09-04');
  assert.throws(() => readTable(Buffer.from('x'), 'old.xls'), /not supported/);
});

test('CSV fixture (BOM, quoted cells) reads the same as xlsx for the shared rows', () => {
  const c = readTable(CSV, 'history.csv'), x = readTable(XLSX, 'history.xlsx');
  assert.deepEqual(c.headers, x.headers); assert.equal(c.rows.length, 6);
  assert.equal(c.rows[0].cells[5], '1,500');
});

test('plan: groups a customer-day into ONE visit, matches by phone, freezes commissions with the right rule', () => {
  const p = planImport(readTable(XLSX, 'history.xlsx'), REF(), {});
  assert.equal(p.fatal, null);
  assert.equal(p.summary.visits, 5); assert.equal(p.summary.serviceLines, 6);
  const mary = p.visits[0]; assert.equal(mary.customer.name, 'Mary Wanjiku'); assert.equal(mary.lines.length, 2); assert.equal(mary.total, 500000);
  assert.equal(p.summary.customersMatched, 1); assert.equal(p.summary.customersNew, 2);       // Sheila matched by phone despite a different name
  const sheila = p.visits.find((v) => v.customer.id === 900); assert.ok(sheila);
  const braids = p.visits.find((v) => v.customer.name === 'Jane Atieno').lines[0];
  assert.equal(braids.commission.amountCents, 195000);         // HAIR: 50% of (4500 - 2 x 300 materials)
  assert.equal(mary.lines[0].commission.amountCents, 60000);   // NAILS default: 40% of 1500
  assert.equal(p.summary.commissionMarkedPaid, 6500); assert.equal(p.summary.commissionLeftPending, 600);   // only the current week stays pending
  assert.deepEqual(p.errors.map((e) => e.row).sort((a, b) => a - b), [8, 9, 10, 11, 12]);
  assert.match(p.errors.find((e) => e.row === 10).message, /Zumba/);
  assert.equal(p.unknown.services[0].name, 'Zumba');
});

test('plan: re-importing is still recognised after the customers have been created by the first import', () => {
  const ref = REF(); const first = planImport(readTable(XLSX, 'history.xlsx'), ref, {});
  first.visits.forEach((v) => ref.importKeys.add(v.importKey));
  let id = 500; for (const c of first.newCustomers) { const rec = { id: ++id, full_name: c.name, phone_normalized: c.phone || null }; if (rec.phone_normalized) ref.byPhone.set(rec.phone_normalized, rec); const k = c.name.toLowerCase(); ref.byName.set(k, [...(ref.byName.get(k) || []), rec]); }
  const again = planImport(readTable(XLSX, 'history.xlsx'), ref, {});
  assert.equal(again.visits.length, 0);
});

test('plan: re-importing the same file creates nothing new (fingerprints), and names alone never merge two same-named people', () => {
  const ref = REF(); const first = planImport(readTable(XLSX, 'history.xlsx'), ref, {});
  first.visits.forEach((v) => ref.importKeys.add(v.importKey));
  const again = planImport(readTable(XLSX, 'history.xlsx'), ref, {});
  assert.equal(again.visits.length, 0); assert.equal(again.summary.duplicatesSkipped, 5);
  const r2 = REF(); r2.byName.set('jane atieno', [{ id: 1, full_name: 'Jane Atieno', phone_normalized: '254700000001' }, { id: 2, full_name: 'Jane Atieno', phone_normalized: '254700000002' }]);
  const p = planImport(readTable(XLSX, 'history.xlsx'), r2, {});
  assert.ok(p.errors.some((e) => /2 customers are named "Jane Atieno"/.test(e.message)));
});

test('plan: missing column is reported plainly; opt-in creation of unknown services/technicians', () => {
  const bad = planImport({ headers: ['Foo', 'Bar'], rows: [] }, REF(), {});
  assert.equal(bad.fatal.code, 'MISSING_COLUMNS');
  const p = planImport(readTable(XLSX, 'history.xlsx'), REF(), { createServices: true, createTechnicians: true });
  assert.equal(p.summary.newServices[0].name, 'Zumba'); assert.deepEqual(p.summary.newTechnicians, ['Nobody']);
});

// ---------------------------------------------------------------- DB layer against a recording stub
function importDb() {
  const log = []; let id = 100;
  const R = (rows = [], rowCount = rows.length) => ({ rows, rowCount });
  return { log, async query(sql, params = []) {
    const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))];
    assert.equal(used.length ? Math.max(...used) : 0, params.length, 'param count mismatch: ' + sql.replace(/\s+/g, ' ').slice(0, 100));
    const s = sql.replace(/\s+/g, ' ').trim(); log.push({ sql: s, params });
    if (/business_today\(\)::text AS d/.test(s)) return R([{ d: '2026-10-13' }]);
    if (/^SELECT id, name, code, category_id, standard_price FROM services/.test(s)) return R([{ id: '1', name: 'Gel Polish', code: 'GEL', category_id: '1', standard_price: '1500' }, { id: '2', name: 'Acrylic Full Set', code: 'ACR', category_id: '1', standard_price: '3500' }, { id: '3', name: 'Knotless Braids', code: 'KB', category_id: '2', standard_price: '4500' }]);
    if (/^SELECT id, display_name, branch_id FROM technicians/.test(s)) return R([{ id: '10', display_name: 'Faith', branch_id: '1' }, { id: '11', display_name: 'Grace', branch_id: '1' }]);
    if (/FROM branches WHERE is_active/.test(s)) return R([{ id: '1', code: 'KIL', name: 'Kilimani' }]);
    if (/FROM service_categories/.test(s)) return R([{ id: '1', code: 'NAILS' }, { id: '2', code: 'HAIR' }]);
    if (/FROM products p WHERE p.is_active/.test(s)) return R([{ id: '50', sku: 'GEL1', name: 'Gel', cost: '200' }, { id: '51', sku: 'BR', name: 'Braids', cost: '300' }]);
    if (/FROM customers WHERE deleted_at IS NULL/.test(s)) return R([{ id: '900', full_name: 'Sheila Njeri', phone_normalized: '254799999999' }]);
    if (/SELECT import_key FROM transactions/.test(s)) return R();
    if (/DISTINCT customer_id/.test(s)) return R();
    if (/FROM commission_rules WHERE is_active/.test(s)) return R([
      { id: '1', scope: 'default', category_id: null, service_id: null, technician_id: null, calc_type: 'percent_of_price', rate: 0.4, effective_from: '2020-01-01', effective_to: null, is_active: true },
      { id: '2', scope: 'category', category_id: '2', service_id: null, technician_id: null, calc_type: 'percent_after_materials', rate: 0.5, effective_from: '2020-01-01', effective_to: null, is_active: true }]);
    if (/^INSERT INTO (import_batches|customers|visits|transactions|transaction_items|commission_payments|services|technicians) /.test(s)) return R([{ id: String(++id) }]);
    if (/next_receipt_no/.test(s)) return R([{ r: 'KIL-2026-' + String(++id) }]);
    if (/FROM import_batches WHERE id/.test(s)) return R([{ id: '101', status: 'committed', created_refs: { customers: [102, 103], services: [], technicians: [] } }]);
    if (/FROM transactions WHERE import_batch_id/.test(s)) return R([{ id: '201', visit_id: '301', customer_id: '102' }, { id: '202', visit_id: '302', customer_id: '103' }]);
    if (/FROM transactions WHERE id=\$1 FOR UPDATE/.test(s)) return R([{ id: params[0], branch_id: '1', status: 'paid', amount_paid: '1500', import_batch_id: '101' }]);
    if (/^UPDATE customers SET deleted_at/.test(s)) return R([], 2);
    return R();
  } };
}
const find = (db, re) => db.log.filter((l) => re.test(l.sql));
const OPT = { skipInvalidRows: true };

test('preview writes nothing and explains the problems', async () => {
  const db = importDb(); const out = await previewImport(db, XLSX, 'history.xlsx', {});
  assert.equal(out.ok, true); assert.equal(out.canCommit, false); assert.equal(out.needsSkipInvalidRows, true);
  assert.equal(out.summary.visits, 5); assert.equal(out.errors.total, 5); assert.equal(out.sample[0].lines[0].commission, 600);
  assert.equal(db.log.filter((l) => /^(INSERT|UPDATE|DELETE)/.test(l.sql)).length, 0);
});

test('commit refuses a file with bad rows unless the owner chooses to skip them; nothing is written before that decision', async () => {
  const db = importDb();
  await assert.rejects(commitImport(db, XLSX, 'history.xlsx', {}, { userId: 1 }), (e) => e.code === 'ROWS_INVALID' && e.details.errors.length === 5);
  assert.equal(find(db, /^INSERT/).length, 0);
});

test('commit writes customers, visits, sales, materials, commissions and payments in the right order, without touching stock', async () => {
  const db = importDb(); const out = await commitImport(db, XLSX, 'history.xlsx', OPT, { userId: 1 });
  assert.match(db.log[0].sql, /pg_advisory_xact_lock/);
  assert.equal(out.summary.transactions, 5); assert.equal(out.summary.items, 6); assert.equal(out.summary.customersCreated, 2);
  assert.deepEqual(find(db, /^INSERT INTO customers/).map((l) => l.params[0]), ['Mary Wanjiku', 'Jane Atieno']);   // Sheila reused, not duplicated
  assert.equal(find(db, /^INSERT INTO customers/).every((l) => /false,false,false/.test(l.sql)), true);            // no marketing consent
  assert.equal(find(db, /^INSERT INTO transactions/).length, 5);
  const txs = find(db, /^INSERT INTO transactions/);
  assert.deepEqual(txs.map((l) => l.params[0]), ['2026-09-01', '2026-09-02', '2026-09-04', '2026-09-05', '2026-10-12']);   // oldest first
  assert.ok(txs.every((l) => l.params.at(-1).length === 40));                                                       // import_key fingerprint on every sale
  const pays = find(db, /^INSERT INTO commission_payments/);
  assert.deepEqual(pays.map((l) => [l.params[0], l.params[4]]).sort(), [[10, '2600.00'], [11, '3900.00']]);
  const cc = find(db, /^INSERT INTO commission_calculations/);
  assert.equal(cc.length, 6); assert.equal(cc.filter((l) => l.params[13] === 'paid').length, 5); assert.equal(cc.filter((l) => l.params[13] === 'pending').length, 1);
  assert.ok(db.log.indexOf(pays[0]) < db.log.indexOf(cc[0]));                                                       // payment exists before lines point at it
  assert.equal(find(db, /^INSERT INTO material_usage/).length, 4);
  assert.equal(find(db, /^(INSERT|UPDATE) .*inventory/).length, 0);                                                                  // history never moves today's stock
  assert.equal(find(db, /^INSERT INTO payments/).length, 5);
  const refs = find(db, /^INSERT INTO payments/).map((l) => l.params[5]);
  assert.equal(new Set(refs).size, refs.length);                                  // M-Pesa references must be unique (database rule)
  assert.ok(refs.every((r) => /^IMPORT-/.test(r)));
  assert.ok(find(db, /^UPDATE visits v SET is_new_customer/).length === 1);
  assert.ok(find(db, /^UPDATE import_batches SET summary/).length === 1);
});

test('rollback voids every imported sale without stock moves or refunds, and retires imported customers', async () => {
  const db = importDb(); const out = await rollbackBatch(db, 101, { userId: 1, reason: 'Wrong file' });
  assert.equal(out.salesVoided, 2);
  const rev = find(db, /^INSERT INTO commission_calculations/); assert.equal(rev.length, 2); assert.ok(rev.every((l) => l.params[1] === true));
  assert.equal(find(db, /^INSERT INTO payments/).length, 0); assert.equal(find(db, /inventory_transactions/).length, 0);
  assert.equal(find(db, /^UPDATE transactions SET status='voided'/).length, 2);
  assert.ok(find(db, /^UPDATE visits SET status = 'cancelled'/).length === 1);
  assert.ok(find(db, /^UPDATE import_batches SET status='rolled_back'/).length === 1);
  await assert.rejects(rollbackBatch(db, 101, { userId: 1, reason: '' }), /reason/i);
});

// ---------------------------------------------------------------- HTTP routes
const USERS = { 1: 'owner', 4: 'manager', 2: 'receptionist' };
async function boot() {
  const calls = { preview: [], commit: [], rollback: [], tx: [] };
  const db = { async query(sql, params = []) {
    if (/FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id/.test(sql)) {
      const role = USERS[params[0]]; return { rowCount: 1, rows: [{ id: Number(params[0]), full_name: role, is_active: true, role, perms: ROLES[role].permissions, branches: [1], technician_id: null }] };
    }
    return { rows: [], rowCount: 0 };
  } };
  const importer = {
    previewImport: async (d, buf, name, options) => { calls.preview.push({ len: buf.length, name, options }); return { ok: true }; },
    commitImport: async (c, buf, name, options, o) => { calls.commit.push({ name, options, o }); return { batchId: 1 }; },
    rollbackBatch: async (c, id, o) => { calls.rollback.push({ id, o }); return { batchId: id }; }, listBatches: async () => [] };
  const app = createApp();
  registerRoutes(app, { db, secret: 's'.repeat(40), tx: (opts, fn) => { calls.tx.push(opts); return fn(db); }, deps: { importer } });
  const server = http.createServer(app.handler); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, as) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${signToken({ sub: String(as) }, 's'.repeat(40))}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { calls, call, close: () => server.close() };
}

test('import routes: only people with data.import; options are whitelisted; big files get through; branch scope enforced', async () => {
  const s = await boot(); const file = { filename: 'history.xlsx', contentBase64: XLSX.toString('base64') };
  assert.equal((await s.call('/import/preview', file)).status, 401);
  assert.equal((await s.call('/import/preview', file, 4)).status, 403);        // manager
  assert.equal((await s.call('/import/preview', file, 2)).status, 403);        // receptionist
  const ok = await s.call('/import/preview', { ...file, options: { dateFormat: 'mdy', createServices: 'yes', skipInvalidRows: true, evil: 1, mapping: { amount: 'Total' } } }, 1);
  assert.equal(ok.status, 200);
  const o = s.calls.preview[0].options;
  assert.equal(o.dateFormat, 'mdy'); assert.equal(o.createServices, false); assert.equal(o.skipInvalidRows, true); assert.equal(o.evil, undefined); assert.deepEqual(o.mapping, { amount: 'Total' });
  assert.deepEqual(o.allowedBranchIds, [1]);
  assert.equal((await s.call('/import/preview', { ...file, options: { branchId: 2 } }, 1)).status, 403);           // someone else's branch
  assert.equal((await s.call('/import/preview', { ...file, options: { mapping: { amount: 5 } } }, 1)).status, 422);
  assert.equal((await s.call('/import/preview', { filename: 'x.csv' }, 1)).status, 422);
  const big = await s.call('/import/preview', { filename: 'big.csv', contentBase64: Buffer.alloc(2_000_000, 'a').toString('base64') }, 1);   // > the 1 MB default body limit
  assert.equal(big.status, 200); assert.equal(s.calls.preview.at(-1).len, 2_000_000);
  assert.equal((await s.call('/sales', { }, 1)).status !== 413, true);
  s.close();
});

test('commit and rollback run inside one audited transaction with a reason; rollback needs a reason', async () => {
  const s = await boot(); const file = { filename: 'history.xlsx', contentBase64: XLSX.toString('base64') };
  const c = await s.call('/import/commit', file, 1); assert.equal(c.status, 201);
  assert.equal(s.calls.tx[0].userId, 1); assert.match(s.calls.tx[0].reason, /history\.xlsx/); assert.equal(s.calls.commit[0].o.userId, 1);
  assert.equal((await s.call('/import/7/rollback', {}, 1)).status, 422);
  assert.equal((await s.call('/import/7/rollback', { reason: 'Wrong month' }, 1)).status, 200); assert.equal(s.calls.rollback[0].id, 7);
  s.close();
});

test('import: a plain amount in Materials is the materials cost (bought for the job) and reduces after-materials commission', () => {
  const T = (mat) => readTable(Buffer.from(`Date,Customer,Service,Technician,Amount,Materials\n10/10/2026,Walk-in Client,Knotless Braids,Faith,1400,"${mat}"\n`), 'x.csv');
  const run = (mat) => planImport(T(mat), REF(), {});
  const a = run('210'); assert.equal(a.errors.length, 0);
  assert.deepEqual([a.visits[0].lines[0].materialCents, a.visits[0].lines[0].commission.amountCents], [21000, 59500]);   // 50% x (1,400 - 210)
  assert.equal(run('KSh 1,200').visits[0].lines[0].commission.amountCents, 10000);
  assert.equal(run('1500').errors.length, 1);                                                                         // more than the price
  assert.equal(run('Braids x2').visits[0].lines[0].materialCents, 60000);                                             // stock items still work
});
