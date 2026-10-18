import { createApp } from './http/app.js';
import { registerRoutes } from './api/routes.js';
import { withTx } from './db/pool.js';

export function buildApp({ pool, secret, corsOrigin = process.env.CORS_ORIGIN || null, deps, now, db, tx }) {
  const app = createApp({ corsOrigin });
  registerRoutes(app, { db: db || pool, tx: tx || ((opts, fn) => withTx(pool, opts, fn)), secret, deps, now });
  return app;
}
