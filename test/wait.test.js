import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForDb } from '../src/db/wait.js';
test('retries until the database answers', async () => {
  let n = 0; const pool = { query: async () => { if (++n < 3) throw new Error('getaddrinfo ENOTFOUND x'); } };
  await waitForDb(pool, { log: () => {}, sleep: async () => {} }); assert.equal(n, 3);
});
test('gives up with a clear message', async () => {
  const pool = { query: async () => { throw new Error('ENOTFOUND'); } };
  await assert.rejects(waitForDb(pool, { tries: 2, log: () => {}, sleep: async () => {} }), /after 2 attempts: ENOTFOUND.*CURRENT Postgres/);
});
