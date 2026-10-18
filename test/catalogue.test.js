import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE, loadCatalogue } from '../src/db/catalogue.js';

test('catalogue has unique codes, valid categories and the posted prices', () => {
  const codes = CATALOGUE.map((x) => x[0]); assert.equal(new Set(codes).size, codes.length);
  for (const [, name, cat, price, mins] of CATALOGUE) { assert.ok(name && price > 0 && mins > 0); assert.ok(['NAILS', 'WAXING', 'HAIR', 'MASSAGE', 'FACIAL', 'LASHES', 'MAKEUP', 'PIERCING'].includes(cat)); }
  const p = (c) => CATALOGUE.find((x) => x[0] === c)[3];
  assert.equal(p('NAIL-SCULPTING'), 1800); assert.equal(p('WAX-FULL-BODY'), 4900); assert.equal(p('MSG-DEEP-TISSUE'), 3500); assert.equal(p('HAIR-ART-LOCS-WAIST'), 5500);
  assert.equal(CATALOGUE.length, 53);
});
test('loadCatalogue is one transaction, never overwrites, and counts new rows', async () => {
  const q = []; let n = 0;
  const c = { async query(sql, p) { q.push(sql.slice(0, 12)); if (/INSERT/.test(sql)) { assert.ok(/ON CONFLICT \(code\) DO NOTHING/.test(sql)); assert.equal(p.length, 5); return { rowCount: n++ % 2 }; } return { rows: [] }; }, release() { q.push('release'); } };
  const r = await loadCatalogue({ connect: async () => c }, () => {});
  assert.equal(r.total, 53); assert.equal(r.added, 26); assert.equal(q[0], 'BEGIN'); assert.equal(q.at(-2), 'COMMIT'); assert.equal(q.at(-1), 'release');
});

test('roster: 19 nail technicians and 6 hairdressers, loaded once into the first branch', async () => {
  const { ROSTER, loadRoster } = await import('../src/db/roster.js');
  assert.equal(ROSTER.NAILS.length, 19); assert.equal(ROSTER.HAIR.length, 6);
  const q = []; const c = { async query(sql, p) { q.push(sql.slice(0, 10)); if (/FROM branches/.test(sql)) return { rowCount: 1, rows: [{ id: 1, name: 'Branch 1' }] };
    if (/INSERT/.test(sql)) { assert.equal(p.length, 3); return { rowCount: 1 }; } return { rows: [] }; }, release() {} };
  assert.deepEqual(await loadRoster({ connect: async () => c }, () => {}), { added: 25, total: 25 }); assert.equal(q.at(-1), 'COMMIT');
});

test('branch 2: Beauty Palace Kenya with 9 nail technicians and 4 hairdressers, owners given access', async () => {
  const { BRANCH2, loadBranch2 } = await import('../src/db/branch2.js');
  assert.equal(BRANCH2.name, 'Beauty Palace Kenya'); assert.equal(BRANCH2.roster.NAILS.length, 9); assert.equal(BRANCH2.roster.HAIR.length, 4);
  const log = [];
  const c = { async query(sql, p = []) {
    const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))]; assert.equal(used.length ? Math.max(...used) : 0, p.length);
    log.push(sql.slice(0, 20));
    if (/SELECT id FROM branches/.test(sql)) return { rowCount: 1, rows: [{ id: 2 }] };
    if (/INSERT INTO technicians/.test(sql)) return { rowCount: 1 };
    if (/INSERT INTO user_branches/.test(sql)) return { rowCount: 2 };
    return { rowCount: 0, rows: [] }; }, release() {} };
  assert.deepEqual(await loadBranch2({ connect: async () => c }, () => {}), { branchId: 2, added: 13, total: 13 });
  assert.equal(log.at(-1), 'COMMIT');
});

test('receipt prefixes: Branch 1 becomes CNS, Branch 2 is BPK', async () => {
  const { MIGRATIONS } = await import('../src/db/migrate.js'); const { BRANCH2 } = await import('../src/db/branch2.js');
  assert.equal(BRANCH2.code, 'BPK');
  assert.ok(MIGRATIONS.some(([, sql]) => /SET code = 'CNS'/.test(sql) && /MIN\(id\)/.test(sql)));
  assert.ok(MIGRATIONS.some(([, sql]) => /SET code = 'BPK'/.test(sql)));
});
