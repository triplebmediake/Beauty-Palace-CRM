import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { verifyPassword } from '../src/auth/password.js';

const mk = ({ users = [], branches = [{ id: 1 }] } = {}) => { const log = [];
  const c = { async query(sql, p = []) { log.push({ sql: sql.replace(/\s+/g, ' ').trim(), p });
    if (/FROM users WHERE email/.test(sql)) return { rows: users.filter((u) => u.email === p[0]), rowCount: users.filter((u) => u.email === p[0]).length };
    if (/FROM users LIMIT 1/.test(sql)) return { rows: users, rowCount: users.length };
    if (/FROM branches/.test(sql)) return { rows: branches, rowCount: branches.length };
    if (/FROM roles/.test(sql)) return { rows: [{ id: 9 }], rowCount: 1 };
    if (/INSERT INTO users/.test(sql)) return { rows: [{ id: 5 }], rowCount: 1 };
    return { rows: [], rowCount: 0 }; } };
  return { log, c, withTx: async (_p, _o, fn) => fn(c) }; };

test('creates the first admin, trimming and lower-casing the email', async () => {
  const m = mk(); const r = await bootstrapAdmin(m.withTx, null, { ADMIN_EMAIL: '  Boss@Example.com ', ADMIN_NAME: ' Boss ', ADMIN_PASSWORD: 'Strong12345' }, () => {});
  assert.equal(r.action, 'created'); const ins = m.log.find((l) => /INSERT INTO users/.test(l.sql)); assert.equal(ins.p[0], 'boss@example.com'); assert.equal(ins.p[1], 'Boss');
});
test('an existing admin is left alone unless ADMIN_RESET=true, and a reset sets the new password and unlocks', async () => {
  const m = mk({ users: [{ id: 1, email: 'boss@example.com' }] }); const env = { ADMIN_EMAIL: 'boss@example.com', ADMIN_NAME: 'B', ADMIN_PASSWORD: 'NewStrong123' };
  assert.equal((await bootstrapAdmin(m.withTx, null, env, () => {})).action, 'skipped');
  const r = await bootstrapAdmin(m.withTx, null, { ...env, ADMIN_RESET: 'TRUE' }, () => {}); assert.equal(r.action, 'reset');
  const up = m.log.find((l) => /UPDATE users SET password_hash/.test(l.sql)); assert.ok(await verifyPassword('NewStrong123', up.p[1])); assert.match(up.sql, /locked_until = NULL/);
});
test('nothing happens without all three settings', async () => { assert.equal((await bootstrapAdmin(mk().withTx, null, { ADMIN_EMAIL: 'a@b.c' }, () => {})).action, 'none'); });
