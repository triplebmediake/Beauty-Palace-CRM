import http from 'node:http';
import { makePool, withTx } from './db/pool.js';
import { buildApp } from './app.js';
import { bootstrapAdmin } from './auth/bootstrap.js';
import { runSetup } from './db/setup.js';
import { databaseUrl } from './lib/dburl.js';
import { waitForDb } from './db/wait.js';
import { loadCatalogue } from './db/catalogue.js';
import { loadRoster } from './db/roster.js';
import { migrate } from './db/migrate.js';
import { loadBranch2 } from './db/branch2.js';

const { JWT_SECRET, PORT = 3000, RUN_SETUP, BRANCH_CODE, BRANCH_NAME } = process.env;
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('Set JWT_SECRET to a random string of at least 32 characters');
const db = databaseUrl(process.env);
let host = '?'; try { host = new URL(db.url).host; } catch { /* leave as ? */ }
console.log(`Database setting found: ${db.source} (host ${host})`);
const pool = makePool(db.url);

try { await waitForDb(pool); } catch (e) { console.error('DATABASE UNREACHABLE -> ' + e.message); }
if (RUN_SETUP === 'true') {
  try { await runSetup(pool, { branchCode: BRANCH_CODE, branchName: BRANCH_NAME }); }
  catch (e) { console.error('SETUP FAILED -> ' + e.message); }      // keep running so the log can be read and /health still answers
}
try { await migrate(pool); } catch (e) { console.error('MIGRATION FAILED -> ' + e.message); }
if (process.env.LOAD_CATALOGUE === 'true') {
  try { await loadCatalogue(pool); }
  catch (e) { console.error('CATALOGUE LOAD FAILED -> ' + e.message); }
}
if (process.env.LOAD_ROSTER === 'true') {
  try { await loadRoster(pool); }
  catch (e) { console.error('ROSTER LOAD FAILED -> ' + e.message); }
}
if (process.env.LOAD_BRANCH2 === 'true') {
  try { await loadBranch2(pool); }
  catch (e) { console.error('BRANCH 2 LOAD FAILED -> ' + e.message); }
}
const app = buildApp({ pool, secret: JWT_SECRET });
try { await bootstrapAdmin(withTx, pool, process.env); } catch (e) { console.error('Admin bootstrap failed:', e.message); }
http.createServer(app.handler).listen(PORT, () => console.log(`Salon API listening on ${PORT}`));
