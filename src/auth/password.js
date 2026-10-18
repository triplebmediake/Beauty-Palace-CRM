import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from '../errors.js';
const scryptAsync = promisify(scrypt);
const N = 16384, R = 8, P = 1, LEN = 64;

export function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new AppError(422, 'WEAK_PASSWORD', 'Password must be at least 10 characters');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw new AppError(422, 'WEAK_PASSWORD', 'Password needs letters and numbers');
}
export async function hashPassword(pw) {
  checkPasswordPolicy(pw);
  const salt = randomBytes(16);
  const h = await scryptAsync(pw, salt, LEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), h.toString('base64')].join('$');
}
export async function verifyPassword(pw, stored) {
  try {
    const [alg, n, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = await scryptAsync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +n, r: +r, p: +p });
    return got.length === want.length && timingSafeEqual(got, want);
  } catch { return false; }
}
