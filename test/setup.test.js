import test from 'node:test';
import assert from 'node:assert/strict';
import { runSetup } from '../src/db/setup.js';

const fakePool = (exists, failOn) => { const q = []; const c = { async query(sql, p) { q.push(sql.slice(0, 40)); 
  if (/to_regclass/.test(sql)) return { rows: [{ t: exists ? 'users' : null }] };
  if (failOn && sql.startsWith(failOn)) { const e = new Error('relation "x" does not exist'); e.position = '77'; throw e; }
  return { rows: [] }; }, release() { q.push('release'); } }; return { q, connect: async () => c }; };
const files = (n) => n === 'schema.sql' ? 'SCHEMA...' : 'SEED...';

test('setup runs schema, seed and the first branch on an empty database', async () => {
  const p = fakePool(false); const r = await runSetup(p, { branchCode: 'MAIN', branchName: 'Main', log: () => {}, files });
  assert.equal(r.ran, true); assert.deepEqual(p.q.filter((x) => /SCHEMA|SEED|INSERT/.test(x)).map((x) => x.slice(0, 6)), ['SCHEMA', 'SEED..', 'INSERT']); assert.equal(p.q.at(-1), 'release');
});
test('setup does nothing on a database that is already set up', async () => {
  const p = fakePool(true); assert.equal((await runSetup(p, { log: () => {}, files })).ran, false); assert.equal(p.q.some((x) => /SCHEMA|SEED/.test(x)), false);
});
test('a failing script reports a readable error, rolls back and releases the connection', async () => {
  const p = fakePool(false, 'SCHEMA');
  await assert.rejects(runSetup(p, { log: () => {}, files }), /schema\.sql failed: relation "x" does not exist \(at character 77/);
  assert.ok(p.q.includes('ROLLBACK')); assert.equal(p.q.at(-1), 'release');
});
