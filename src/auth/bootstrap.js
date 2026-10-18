// First-run / recovery helper for hosts without a shell. Driven by settings:
//   ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD         create the first super admin when there are NO users yet
//   ADMIN_RESET=true (plus the three above)          set a new password for that admin (and unlock the account)
// Values are trimmed, because stray spaces are the most common reason a login "does not match".
import { createUser } from './service.js';
import { hashPassword } from './password.js';

export async function bootstrapAdmin(withTx, pool, env, log = console.log) {
  const email = (env.ADMIN_EMAIL || '').trim().toLowerCase(), name = (env.ADMIN_NAME || '').trim(), password = env.ADMIN_PASSWORD || '';
  if (!email || !name || !password) return { action: 'none' };
  const reset = String(env.ADMIN_RESET || '').trim().toLowerCase() === 'true';
  return withTx(pool, { reason: reset ? 'Admin password reset (bootstrap)' : 'Initial super admin (bootstrap)' }, async (c) => {
    const existing = await c.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rowCount && reset) {
      const hash = await hashPassword(password);
      await c.query(`UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, is_active = true WHERE id = $1`, [existing.rows[0].id, hash]);
      log(`Password RESET for ${email}. Now delete ADMIN_PASSWORD and ADMIN_RESET from the settings.`);
      return { action: 'reset', id: Number(existing.rows[0].id) };
    }
    if (existing.rowCount) { log(`Admin bootstrap skipped: ${email} already exists. (To set a new password add ADMIN_RESET=true.)`); return { action: 'skipped' }; }
    if ((await c.query('SELECT 1 FROM users LIMIT 1')).rowCount) { log('Admin bootstrap skipped: other users already exist and none has the email ' + email + '.'); return { action: 'skipped' }; }
    const b = await c.query('SELECT id FROM branches ORDER BY id');
    if (!b.rowCount) throw new Error('No branch exists yet. Insert one, then restart.');
    const id = await createUser(c, { email, fullName: name, password, roleCode: 'super_admin', branchIds: b.rows.map((r) => r.id) });
    log(`Created first super admin ${email} (id ${id}). Now delete ADMIN_PASSWORD from the settings.`);
    return { action: 'created', id };
  });
}
