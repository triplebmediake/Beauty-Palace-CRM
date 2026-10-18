// Minimal HTTP app on Node's built-in modules (no Express needed). Handlers are (req, res, next) like Express.
import { AppError } from '../errors.js';
import { errorHandler } from '../auth/http.js';

const MAX_BODY = 1_000_000;
const readBody = (req, max = MAX_BODY) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > max) { reject(new AppError(413, 'TOO_LARGE', 'Request too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  req.on('error', reject);
});
const step = (fn, req, res) => new Promise((resolve, reject) => {
  let called = false;
  const next = (e) => { called = true; e ? reject(e) : resolve(true); };
  Promise.resolve(fn(req, res, next)).then(() => { if (!called) resolve(false); }, reject);
});

export function createApp({ corsOrigin = null } = {}) {
  const routes = [], before = [];
  const add = (method, path, ...h) => {
    const opts = typeof h[0] === 'object' ? h.shift() : {};      // optional { maxBody } before the handlers
    const keys = [];
    const re = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, h, maxBody: opts.maxBody });
  };
  const handler = async (req, res) => {
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
    res.send = (text, type = 'text/plain; charset=utf-8') => { res.setHeader('Content-Type', type); res.end(text); return res; };
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (corsOrigin && req.headers.origin === corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    }
    try {
      if (req.method === 'OPTIONS') return res.status(204).end();
      const url = new URL(req.url, 'http://x');
      req.path = url.pathname; req.query = Object.fromEntries(url.searchParams);
      const route = routes.find((r) => r.method === req.method && r.re.test(req.path));
      if (!route) throw new AppError(404, 'NOT_FOUND', 'Not found');
      const m = route.re.exec(req.path); req.params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const raw = await readBody(req, route.maxBody);
        try { req.body = raw ? JSON.parse(raw) : {}; } catch { throw new AppError(400, 'BAD_JSON', 'Body must be valid JSON'); }
      } else req.body = {};
      for (const fn of [...before, ...route.h]) if (!(await step(fn, req, res))) return;
    } catch (e) { errorHandler(e, req, res); }
  };
  return { handler, use: (fn) => before.push(fn),
    get: (p, ...h) => add('GET', p, ...h), post: (p, ...h) => add('POST', p, ...h), put: (p, ...h) => add('PUT', p, ...h), delete: (p, ...h) => add('DELETE', p, ...h) };
}
