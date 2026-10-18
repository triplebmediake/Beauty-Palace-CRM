// Work out the database address from the settings the host provides, and explain clearly when it cannot be found.
// Only setting NAMES are ever reported, never values (values contain passwords).
export function databaseUrl(env) {
  const tryList = ['DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL', 'POSTGRES_URL'];
  for (const k of tryList) { const v = (env[k] || '').trim(); if (/^postgres(ql)?:\/\//i.test(v)) return { url: v, source: k }; }
  const { PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT = '5432' } = env;
  if (PGHOST && PGUSER && PGPASSWORD && PGDATABASE)
    return { url: `postgres://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/${PGDATABASE}`, source: 'PG* settings' };
  const present = tryList.filter((k) => k in env);
  const why = present.length
    ? `${present.join(', ')} ${present.length > 1 ? 'are' : 'is'} set but does not start with postgres:// (${present.map((k) => (env[k] || '').trim() === '' ? `${k} is EMPTY` : /^\$\{\{/.test((env[k] || '').trim()) ? `${k} still contains an unresolved reference` : `${k} has an unexpected format`).join('; ')})`
    : 'no database setting exists at all';
  const mine = Object.keys(env).filter((k) => /^(JWT_SECRET|NODE_ENV|RUN_SETUP|BRANCH_|ADMIN_|CORS_|PORT|DATABASE|PG|POSTGRES)/.test(k)).sort();
  const e = new Error(`DATABASE_URL is missing: ${why}. In Railway, open the Postgres service > Variables, copy DATABASE_URL, and paste it as the value of DATABASE_URL on this service. Settings this app can see: ${mine.join(', ') || '(none)'}`);
  e.code = 'NO_DATABASE_URL'; throw e;
}
