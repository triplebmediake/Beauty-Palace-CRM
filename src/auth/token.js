import { createHmac, timingSafeEqual } from 'node:crypto';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const HEADER = b64({ alg: 'HS256', typ: 'JWT' });
const sig = (data, secret) => createHmac('sha256', secret).update(data).digest('base64url');

export function signToken(payload, secret, { ttlSec = 8 * 3600, now = Date.now() } = {}) {
  if (!secret || secret.length < 32) throw new Error('JWT secret must be at least 32 characters');
  const iat = Math.floor(now / 1000);
  const body = b64({ ...payload, iat, exp: iat + ttlSec });
  return `${HEADER}.${body}.${sig(`${HEADER}.${body}`, secret)}`;
}
/** Returns the payload, or null for ANY problem (bad format, wrong alg, bad signature, expired). */
export function verifyToken(token, secret, { now = Date.now() } = {}) {
  try {
    const [h, b, s] = String(token).split('.');
    if (h !== HEADER || !b || !s) return null;                  // pins alg to HS256: rejects "none"
    const a = Buffer.from(s), e = Buffer.from(sig(`${h}.${b}`, secret));
    if (a.length !== e.length || !timingSafeEqual(a, e)) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp > Math.floor(now / 1000) ? p : null;
  } catch { return null; }
}
