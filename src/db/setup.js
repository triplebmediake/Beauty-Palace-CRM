// First-run database setup for hosts where you cannot run SQL by hand. Enabled by RUN_SETUP=true.
// SAFE: it only acts when the database has no "users" table yet, i.e. it has never been set up. It never touches existing data.
// schema.sql and seed.sql each run as ONE transaction, so a failure leaves the database empty and you can simply fix and retry.
import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL(`../../db/${name}`, import.meta.url), 'utf8');

export async function runSetup(pool, { branchCode, branchName, log = console.log, files = read } = {}) {
  const client = await pool.connect();
  try {
    const exists = await client.query(`SELECT to_regclass('public.users') AS t`);
    if (exists.rows[0].t) { log('Setup skipped: the database is already set up.'); return { ran: false }; }
    for (const f of ['schema.sql', 'seed.sql']) {
      log(`Setup: running ${f} ...`);
      try { await client.query(files(f)); }
      catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        const where = e.position ? ` (at character ${e.position} of ${f})` : '';
        throw new Error(`${f} failed: ${e.message}${where}${e.detail ? ' | ' + e.detail : ''}${e.hint ? ' | hint: ' + e.hint : ''}`);
      }
    }
    if (branchCode && branchName) {
      await client.query('INSERT INTO branches (code, name) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM branches)', [branchCode, branchName]);
      log(`Setup: branch "${branchName}" ready.`);
    }
    log('Setup finished: tables, roles and default commission rules are in place.');
    return { ran: true };
  } finally { client.release(); }
}
