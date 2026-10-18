import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { signToken, verifyToken } from '../src/auth/token.js';
import { totp, verifyTotp, newSecret } from '../src/auth/totp.js';
import { login, authenticate } from '../src/auth/service.js';
import { requirePermission, requireBranch } from '../src/auth/http.js';
import { ROLES, PERMISSIONS, dataScope } from '../src/auth/permissions.js';

const SECRET = 'x'.repeat(40);

test('passwords: hashed, salted, verified, weak ones refused', async () => {
  const h = await hashPassword('Salon2026pass');
  assert.ok(h.startsWith('scrypt$')); assert.ok(!h.includes('Salon2026pass'));
  assert.equal(await verifyPassword('Salon2026pass', h), true);
  assert.equal(await verifyPassword('salon2026pass', h), false);
  assert.notEqual(h, await hashPassword('Salon2026pass'));
  await assert.rejects(hashPassword('short1'), (e) => e.code === 'WEAK_PASSWORD');
  await assert.rejects(hashPassword('onlyletterspassword'), (e) => e.code === 'WEAK_PASSWORD');
  assert.equal(await verifyPassword('x', 'garbage'), false);
});
test('tokens: valid, tampered, expired, wrong secret, alg none', () => {
  const t = signToken({ sub: '7', role: 'manager' }, SECRET, { now: 1_000_000 });
  assert.equal(verifyToken(t, SECRET, { now: 1_000_000 })?.sub, '7');
  const [h, b, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin', exp: 9e9 })).toString('base64url');
  assert.equal(verifyToken(`${h}.${forged}.${s}`, SECRET, { now: 1_000_000 }), null);
  assert.equal(verifyToken(t, 'y'.repeat(40), { now: 1_000_000 }), null);
  assert.equal(verifyToken(t, SECRET, { now: 1_000_000 + 9 * 3600 * 1000 }), null);
  const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
  assert.equal(verifyToken(`${none}.${b}.`, SECRET, { now: 1_000_000 }), null);
  assert.throws(() => signToken({}, 'short'));
});
test('TOTP matches the RFC 6238 test vector and tolerates one step of clock drift', () => {
  const rfc = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';                 // "12345678901234567890"
  assert.equal(totp(rfc, 59_000, 8), '94287082');
  assert.equal(totp(rfc, 1111111109_000, 8), '07081804');
  const s = newSecret(), now = Date.now();
  assert.equal(verifyTotp(s, totp(s, now), now), true);
  assert.equal(verifyTotp(s, totp(s, now - 30000), now), true);
  assert.equal(verifyTotp(s, totp(s, now - 120000), now), false);
});

// ---- login with a stub db
async function userRow(over = {}) {
  return { id: 5, full_name: 'Wanjiru', password_hash: await hashPassword('Salon2026pass'), is_active: true,
    failed_logins: 0, locked_until: null, mfa_secret: null, role: 'manager', ...over };
}
const stub = (row, extra = () => null) => { const log = [];
  return { log, async query(sql, params) { log.push({ sql, params });
    if (/FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email/.test(sql)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    return extra(sql, params) || { rows: [], rowCount: 0 }; } }; };

test('login: success returns a token that authenticates; bad password counts a failure', async () => {
  const db = stub(await userRow());
  const ok = await login(db, { email: 'A@B.com', password: 'Salon2026pass' }, { secret: SECRET });
  assert.equal(ok.user.role, 'manager'); assert.equal(db.log[0].params[0], 'A@B.com');
  assert.ok(db.log.some((x) => /last_login_at/.test(x.sql)));
  const bad = stub(await userRow());
  await assert.rejects(login(bad, { email: 'a@b.com', password: 'wrong' }, { secret: SECRET }), (e) => e.code === 'INVALID_CREDENTIALS');
  assert.ok(bad.log.some((x) => /failed_logins = failed_logins \+ 1/.test(x.sql)));
});
test('login: unknown email gives the same error; locked and disabled accounts are refused', async () => {
  await assert.rejects(login(stub(null), { email: 'no@x.com', password: 'Salon2026pass' }, { secret: SECRET }), (e) => e.code === 'INVALID_CREDENTIALS');
  const locked = await userRow({ locked_until: new Date(Date.now() + 600000).toISOString() });
  await assert.rejects(login(stub(locked), { email: 'a@b.com', password: 'Salon2026pass' }, { secret: SECRET }), (e) => e.code === 'ACCOUNT_LOCKED');
  const off = await userRow({ is_active: false });
  await assert.rejects(login(stub(off), { email: 'a@b.com', password: 'Salon2026pass' }, { secret: SECRET }), (e) => e.code === 'INVALID_CREDENTIALS');
});
test('login: MFA users need a valid code', async () => {
  const s = newSecret(), row = await userRow({ mfa_secret: s });
  await assert.rejects(login(stub(row), { email: 'a@b.com', password: 'Salon2026pass' }, { secret: SECRET }), (e) => e.code === 'OTP_REQUIRED');
  await assert.rejects(login(stub(row), { email: 'a@b.com', password: 'Salon2026pass', otp: '000000' }, { secret: SECRET, now: 5e12 }), (e) => e.code === 'OTP_INVALID');
  const ok = await login(stub(row), { email: 'a@b.com', password: 'Salon2026pass', otp: totp(s) }, { secret: SECRET });
  assert.ok(ok.token);
});
test('authenticate re-reads the user: deactivated users and bad tokens are refused', async () => {
  const token = signToken({ sub: '5', role: 'manager' }, SECRET);
  const live = { id: 5, full_name: 'W', is_active: true, role: 'receptionist', perms: ['sales.create'], branches: [1], technician_id: null };
  const db = (row) => ({ query: async () => ({ rows: row ? [row] : [] }) });
  const u = await authenticate(db(live), `Bearer ${token}`, { secret: SECRET });
  assert.equal(u.role, 'receptionist');                       // role comes from the DB, not the token
  assert.ok(u.permissions.has('sales.create') && !u.permissions.has('sales.void'));
  await assert.rejects(authenticate(db({ ...live, is_active: false }), `Bearer ${token}`, { secret: SECRET }), (e) => e.code === 'UNAUTHENTICATED');
  await assert.rejects(authenticate(db(live), 'Bearer nope', { secret: SECRET }), (e) => e.code === 'UNAUTHENTICATED');
  await assert.rejects(authenticate(db(live), undefined, { secret: SECRET }), (e) => e.code === 'UNAUTHENTICATED');
});

// ---- permission matrix, straight from the spec
const has = (role, p) => ROLES[role].permissions.includes(p);
test('every role only references permissions that exist', () => {
  for (const [r, v] of Object.entries(ROLES)) for (const p of v.permissions) assert.ok(PERMISSIONS[p], `${r} -> ${p}`);
});
test('receptionist: can sell and book, cannot change history, rules or commissions', () => {
  for (const p of ['customers.manage', 'appointments.manage', 'sales.create', 'payments.process', 'services.view', 'queue.manage']) assert.ok(has('receptionist', p), p);
  for (const p of ['sales.void', 'commissions.rules.manage', 'commissions.view_all', 'pricing.manage', 'discounts.approve', 'reports.financial', 'users.manage']) assert.ok(!has('receptionist', p), p);
});
test('technician: only own sales and own commission', () => {
  for (const p of ['sales.view_own', 'commissions.view_own', 'services.perform', 'materials.record', 'appointments.view_own']) assert.ok(has('technician', p), p);
  for (const p of ['sales.view', 'commissions.view_all', 'customers.view', 'reports.view', 'sales.create']) assert.ok(!has('technician', p), p);
});
test('accountant: money and reports, no selling or rule changes', () => {
  for (const p of ['reports.financial', 'expenses.manage', 'commissions.pay', 'inventory.valuation', 'payments.reconcile']) assert.ok(has('accountant', p), p);
  for (const p of ['sales.create', 'commissions.rules.manage', 'sales.void', 'users.manage']) assert.ok(!has('accountant', p), p);
});
test('owner can change prices and commission rules but not users, branches or settings; super admin has everything', () => {
  for (const p of ['users.manage', 'settings.manage', 'branches.manage']) { assert.ok(!has('owner', p), p); assert.ok(has('super_admin', p), p); }
  for (const p of ['commissions.rules.manage', 'pricing.manage']) { assert.ok(has('owner', p), p); assert.ok(!has('manager', p), p); }
  assert.ok(has('owner', 'reports.financial') && has('owner', 'commissions.pay') && has('owner', 'marketing.manage'));
  assert.equal(ROLES.super_admin.permissions.length, Object.keys(PERMISSIONS).length);
});
test('only managers and above can approve commissions, and only they can void', () => {
  for (const r of ['receptionist', 'technician']) { assert.ok(!has(r, 'commissions.approve')); assert.ok(!has(r, 'sales.void')); }
  assert.ok(has('manager', 'commissions.approve') && has('manager', 'sales.void'));
});
test('middleware: 401 without a user, 403 with missing permission, branch check', () => {
  const run = (mw, req) => { let err; mw(req, {}, (e) => { err = e; }); return err; };
  const user = (perms, branchIds = [1]) => ({ user: { permissions: new Set(perms), branchIds } });
  assert.equal(run(requirePermission('sales.void'), {}).status, 401);
  assert.equal(run(requirePermission('sales.void'), user(['sales.create'])).status, 403);
  assert.equal(run(requirePermission('sales.void'), user(['sales.void'])), undefined);
  assert.equal(run(requireBranch(() => 2), user([])).code, 'WRONG_BRANCH');
  assert.equal(run(requireBranch(() => 1), user([])), undefined);
  assert.equal(run(requireBranch(() => 2), user(['branches.manage'])), undefined);
});
test('data scope: technicians see only their own rows', () => {
  assert.deepEqual(dataScope({ permissions: new Set(['sales.view_own']), technicianId: 4 }), { type: 'own', technicianId: 4 });
  assert.deepEqual(dataScope({ permissions: new Set(['sales.view']) }), { type: 'all' });
});
