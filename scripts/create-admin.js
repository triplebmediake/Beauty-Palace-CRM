// One-time setup: node --env-file=.env scripts/create-admin.js you@example.com "Your Name" "StrongPassword123"
import { makePool, withTx } from '../src/db/pool.js';
import { createUser } from '../src/auth/service.js';
const [email, fullName, password] = process.argv.slice(2);
if (!email || !fullName || !password) { console.error('Usage: create-admin.js <email> <full name> <password>'); process.exit(1); }
const pool = makePool();
const id = await withTx(pool, { reason: 'Initial super admin' }, async (c) => {
  const b = await c.query('SELECT id FROM branches ORDER BY id LIMIT 1');
  return createUser(c, { email, fullName, password, roleCode: 'super_admin', branchIds: b.rows.map((r) => r.id) });
});
console.log('Created super admin with id', id); await pool.end();
