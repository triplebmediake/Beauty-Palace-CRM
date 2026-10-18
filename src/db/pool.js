import pg from 'pg';

// numeric -> string by default in node-pg; we convert explicitly where needed.
export function makePool(connectionString = process.env.DATABASE_URL) {
  // DATABASE_SSL=true turns on an encrypted connection (needed by some hosted databases reached over their public address).
  const ssl = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined;
  return new pg.Pool({ connectionString, max: 10, ssl });
}

/**
 * Run fn(client) inside ONE database transaction. The user id and reason are stored in
 * transaction-local settings so the audit triggers can record who did what.
 */
export async function withTx(pool, { userId = null, reason = null } = {}, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.reason', $2, true)",
      [userId == null ? '' : String(userId), reason ?? '']);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}
