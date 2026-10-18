import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseUrl } from '../src/lib/dburl.js';
test('finds the database address from the usual names, or builds it from PG* settings', () => {
  assert.equal(databaseUrl({ DATABASE_URL: 'postgresql://u:p@h:5432/d' }).source, 'DATABASE_URL');
  assert.equal(databaseUrl({ DATABASE_URL: '', DATABASE_PUBLIC_URL: 'postgres://u:p@h/d' }).source, 'DATABASE_PUBLIC_URL');
  assert.equal(databaseUrl({ PGHOST: 'h', PGUSER: 'u', PGPASSWORD: 'p@ss', PGDATABASE: 'd' }).url, 'postgres://u:p%40ss@h:5432/d');
});
test('the error says exactly what is wrong and never prints values', () => {
  assert.throws(() => databaseUrl({ DATABASE_URL: '', JWT_SECRET: 'x'.repeat(40) }), (e) => /DATABASE_URL is EMPTY/.test(e.message) && /JWT_SECRET/.test(e.message) && !/xxxx/.test(e.message));
  assert.throws(() => databaseUrl({ DATABASE_URL: '${{Postgres.DATABASE_URL}}' }), /unresolved reference/);
  assert.throws(() => databaseUrl({ NODE_ENV: 'production' }), /no database setting exists at all/);
});
