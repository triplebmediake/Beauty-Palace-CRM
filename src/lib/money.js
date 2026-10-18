// All money inside the engine is INTEGER CENTS so we never suffer floating point drift.
export const toCents = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${v}`);
  return Math.round(n * 100);
};
export const fromCents = (c) => (c / 100).toFixed(2);
export const toBps = (rate) => Math.round(Number(rate) * 10000); // 0.4 -> 4000 basis points
export const mulBps = (cents, bps) => Math.round((cents * bps) / 10000);

// Split `total` cents across `weights` proportionally (largest remainder); sums EXACTLY to total.
export function allocate(total, weights) {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum === 0 ? weights.map(() => 1) : weights;
  const s = BigInt(sum === 0 ? n : sum), T = BigInt(total);
  const base = w.map((x) => (T * BigInt(x)) / s);
  const rem = w.map((x, i) => ({ i, r: (T * BigInt(x)) % s }));
  const left = Number(T - base.reduce((a, b) => a + b, 0n));
  rem.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const out = base.map(Number);
  for (let k = 0; k < left; k++) out[rem[k].i] += 1;
  return out;
}
