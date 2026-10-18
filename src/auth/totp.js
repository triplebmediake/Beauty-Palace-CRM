import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const newSecret = () => { let o = '', bits = '';
  for (const b of randomBytes(20)) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) o += A[parseInt(bits.slice(i, i + 5), 2)]; return o; };
const decode = (s) => { let bits = ''; for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
export function totp(secret, timeMs = Date.now(), digits = 6) {          // RFC 6238, SHA-1, 30 s step
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30000)));
  const h = createHmac('sha1', decode(secret)).update(ctr).digest(), o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
export function verifyTotp(secret, code, timeMs = Date.now()) {            // accepts +/- 1 step for clock drift
  const c = Buffer.from(String(code).trim());
  return [-1, 0, 1].some((d) => { const w = Buffer.from(totp(secret, timeMs + d * 30000)); return w.length === c.length && timingSafeEqual(w, c); });
}
