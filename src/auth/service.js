import { hashPassword, verifyPassword, checkPasswordPolicy } from './password.js';
import { signToken, verifyToken } from './token.js';
import { verifyTotp } from './totp.js';
import { AppError } from '../errors.js';

const MAX_FAILS = 5;
const BAD = () => new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
// Verified when the email does not exist, so unknown and known emails take the same time.
const DUMMY = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export async function login(db, { email, password, otp }, { secret, now = Date.now(), ttlSec } = {}) {
  const r = await db.query(
    `SELECT u.id, u.full_name, u.password_hash, u.is_active, u.failed_logins, u.locked_until, u.mfa_secret, r.code AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = lower($1)`, [String(email || '')]);
  const u = r.rows[0];
  if (!u) { await verifyPassword(password, DUMMY); throw BAD(); }
  if (u.locked_until && new Date(u.locked_until).getTime() > now)
    throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later or ask an administrator.');
  const ok = await verifyPassword(password, u.password_hash);
  if (!ok || !u.is_active) {
    if (u.is_active) await db.query(
      `UPDATE users SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + interval '15 minutes' ELSE locked_until END
        WHERE id = $1`, [u.id, MAX_FAILS]);
    throw BAD();
  }
  if (u.mfa_secret) {
    if (!otp) throw new AppError(401, 'OTP_REQUIRED', 'Enter your 6-digit authentication code');
    if (!verifyTotp(u.mfa_secret, otp, now)) throw new AppError(401, 'OTP_INVALID', 'Authentication code is not valid');
  }
  await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
  return { token: signToken({ sub: String(u.id), role: u.role }, secret, { ttlSec, now }), user: { id: Number(u.id), name: u.full_name, role: u.role } };
}

/**
 * Validate a bearer token AND re-read the user and role permissions from the database on every request,
 * so deactivating a user or editing a role takes effect immediately.
 */
export async function authenticate(db, header, { secret, now = Date.now() } = {}) {
  const m = /^Bearer (.+)$/.exec(header || '');
  const p = m && verifyToken(m[1], secret, { now });
  if (!p) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in');
  const u = await db.query(
    `SELECT u.id, u.full_name, u.is_active, r.code AS role,
            COALESCE((SELECT array_agg(pm.code) FROM role_permissions rp JOIN permissions pm ON pm.id = rp.permission_id WHERE rp.role_id = r.id), '{}') AS perms,
            COALESCE((SELECT array_agg(ub.branch_id) FROM user_branches ub WHERE ub.user_id = u.id), '{}') AS branches,
            (SELECT t.id FROM technicians t WHERE t.user_id = u.id) AS technician_id
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [p.sub]);
  const row = u.rows[0];
  if (!row || !row.is_active) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in');
  return { id: Number(row.id), name: row.full_name, role: row.role, permissions: new Set(row.perms),
    branchIds: row.branches.map(Number), technicianId: row.technician_id == null ? null : Number(row.technician_id) };
}

export async function createUser(db, { email, fullName, phone = null, password, roleCode, branchIds = [] }) {
  checkPasswordPolicy(password);
  const role = await db.query('SELECT id FROM roles WHERE code = $1', [roleCode]);
  if (!role.rowCount) throw new AppError(422, 'UNKNOWN_ROLE', `Unknown role ${roleCode}`);
  const hash = await hashPassword(password);
  const r = await db.query(
    'INSERT INTO users (email, full_name, phone, password_hash, role_id) VALUES (lower($1),$2,$3,$4,$5) RETURNING id',
    [email, fullName, phone, hash, role.rows[0].id]);
  for (const b of branchIds) await db.query('INSERT INTO user_branches (user_id, branch_id) VALUES ($1,$2)', [r.rows[0].id, b]);
  return Number(r.rows[0].id);
}
