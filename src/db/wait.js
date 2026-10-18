// On some hosts the private network is not ready for the first moments after a container starts.
// Try the database a few times before giving up, and say plainly why it failed.
export async function waitForDb(pool, { tries = 15, delayMs = 2000, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { await pool.query('SELECT 1'); if (i > 1) log(`Database reachable after ${i} attempts.`); return; }
    catch (e) { last = e; log(`Waiting for the database (attempt ${i}/${tries}): ${e.message}`); if (i < tries) await sleep(delayMs); }
  }
  throw new Error(`Cannot reach the database after ${tries} attempts: ${last.message}. Check that DATABASE_URL on this service was copied from the CURRENT Postgres service.`);
}
