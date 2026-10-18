// Business settings: name, logo, contact details, opening hours, receipt wording and customer-status rules.
// Stored one row per setting in app_settings (global rows, branch_id NULL).
import { AppError } from '../errors.js';

export const DEFAULT_NAME = 'Cute Nails & Salons Kenya';
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TEXT_KEYS = { 'business.name': 80, 'business.tagline': 120, 'business.phone': 40, 'business.whatsapp': 40, 'business.email': 120, 'business.address': 200,
  'business.website': 120, 'business.instagram': 80, 'business.tax_pin': 40, 'business.receipt_footer': 200 };
const NUM_KEYS = { 'status.default_return_days': [7, 120], 'status.lapsed_days': [14, 400], 'status.winback_days': [30, 500], 'status.inactive_days': [60, 900], 'vip.min_spend': [0, 100000000], 'vip.min_visits': [1, 1000] };
const DEFAULT_HOURS = Object.fromEntries(DAYS.map((d) => [d, { closed: d === 'sun', open: '08:00', close: '20:00' }]));
const DEFAULT_NUM = { 'status.default_return_days': 28, 'status.lapsed_days': 60, 'status.winback_days': 90, 'status.inactive_days': 180, 'vip.min_spend': 50000, 'vip.min_visits': 10 };
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_LOGO_BYTES = 300 * 1024;

/** Salon-wide settings, with a branch's own values laid over them (a branch only overrides what it fills in). */
export async function loadBusiness(db, branchId = null) {
  const bid = branchId == null || branchId === '' || Number.isNaN(Number(branchId)) ? null : Number(branchId);
  const r = await db.query(`SELECT key, value, branch_id FROM app_settings WHERE (branch_id IS NULL OR branch_id = $1) AND (key LIKE 'business.%' OR key LIKE 'status.%' OR key LIKE 'vip.%')`, [bid]);
  const m = {}, overridden = [];
  for (const x of r.rows.filter((y) => y.branch_id == null)) m[x.key] = x.value;
  for (const x of r.rows.filter((y) => y.branch_id != null && String(y.key).startsWith('business.'))) {
    if (x.value === '' || x.value === null) continue;
    m[x.key] = x.value; overridden.push(x.key);
  }
  const str = (k) => (typeof m[k] === 'string' ? m[k] : '');
  const num = (k) => (Number.isFinite(Number(m[k])) && m[k] != null ? Number(m[k]) : DEFAULT_NUM[k]);
  return {
    name: str('business.name') || DEFAULT_NAME, tagline: str('business.tagline'), phone: str('business.phone'), whatsapp: str('business.whatsapp'), email: str('business.email'),
    address: str('business.address'), website: str('business.website'), instagram: str('business.instagram'), taxPin: str('business.tax_pin'),
    receiptFooter: str('business.receipt_footer') || 'Thank you! Book your next appointment.', logo: str('business.logo') || null,
    hours: m['business.hours'] && typeof m['business.hours'] === 'object' ? { ...DEFAULT_HOURS, ...m['business.hours'] } : DEFAULT_HOURS,
    rules: { defaultReturnDays: num('status.default_return_days'), lapsedDays: num('status.lapsed_days'), winbackDays: num('status.winback_days'), inactiveDays: num('status.inactive_days'), vipMinSpend: num('vip.min_spend'), vipMinVisits: num('vip.min_visits') },
    ...(bid ? { branchId: bid, overridden } : {}),
  };
}

const WEEKDAY = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };
const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
/** Throws if an appointment from `start` for `minutes` is not entirely inside the opening hours (Nairobi time). */
export function checkOpeningHours(hours, start, minutes, tz = 'Africa/Nairobi') {
  const part = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  const a = part(start), e = part(new Date(start.getTime() + minutes * 60000));
  const day = WEEKDAY[a.weekday], h = hours[day], from = `${a.hour}:${a.minute}`, to = `${e.hour}:${e.minute}`;
  const sameDay = WEEKDAY[e.weekday] === day;
  if (!h || h.closed) throw new AppError(422, 'CLOSED', `We are closed on ${DAY_NAMES[day]}s. Choose another day.`);
  if (from < h.open || from >= h.close) throw new AppError(422, 'OUTSIDE_HOURS', `${DAY_NAMES[day]} opening hours are ${h.open} to ${h.close}. Choose a time within them.`);
  if (!sameDay || to > h.close) throw new AppError(422, 'OUTSIDE_HOURS', `This booking would end at ${sameDay ? to : 'after midnight'}, after closing time (${h.close}). Choose an earlier time or a shorter service.`);
}

const bad = (m) => new AppError(422, 'BAD_SETTING', m);
const hhmm = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));

export function registerSettingsRoutes(app, { db, tx, secure }) {
  // Public: only what the sign-in page needs (name, tagline and logo are not secret).
  app.get('/branding', async (req, res) => { const b = await loadBusiness(db, req.query.branchId); res.json({ name: b.name, tagline: b.tagline, logo: b.logo, hours: b.hours }); });

  app.get('/settings/business', ...secure('settings.business'), async (req, res) => res.json(await loadBusiness(db, req.query.branchId)));

  app.put('/settings/business', ...secure('settings.business'), async (req, res) => {
    const b = req.body || {}, rows = [];                             // [key, value] pairs to save
    const branchId = b.branchId == null || b.branchId === '' ? null : Number(b.branchId);          // set = save for that branch only (it overrides the salon-wide value)
    if (branchId !== null && !Number.isInteger(branchId)) throw bad('Choose a valid branch');
    if (branchId !== null && b.rules !== undefined) throw bad('Customer status rules apply to the whole business, not one branch');
    const map = { name: 'business.name', tagline: 'business.tagline', phone: 'business.phone', whatsapp: 'business.whatsapp', email: 'business.email', address: 'business.address',
      website: 'business.website', instagram: 'business.instagram', taxPin: 'business.tax_pin', receiptFooter: 'business.receipt_footer' };
    for (const [field, key] of Object.entries(map)) {
      if (b[field] === undefined) continue;
      const v = String(b[field] ?? '').trim();
      if (v.length > TEXT_KEYS[key]) throw bad(`That text is too long (maximum ${TEXT_KEYS[key]} characters)`);
      if (key === 'business.name' && !v && branchId === null) throw bad('The salon name cannot be empty');
      if (key === 'business.email' && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw bad('That email address does not look right');
      rows.push([key, v]);
    }
    if (b.logo !== undefined) {
      if (b.logo === null || b.logo === '') rows.push(['business.logo', '']);
      else {
        if (typeof b.logo !== 'string' || !LOGO_RE.test(b.logo)) throw bad('The logo must be a PNG, JPG or WebP picture');
        if (Math.floor(b.logo.length * 0.75) > MAX_LOGO_BYTES) throw bad('The logo picture is too large (maximum about 300 KB)');
        rows.push(['business.logo', b.logo]);
      }
    }
    if (b.hours !== undefined) {
      const out = {};
      for (const d of DAYS) {
        const x = b.hours?.[d]; if (!x) throw bad('Opening hours are needed for every day of the week');
        if (x.closed) { out[d] = { closed: true, open: '08:00', close: '20:00' }; continue; }
        if (!hhmm(x.open) || !hhmm(x.close)) throw bad('Use times like 08:00 and 20:00');
        if (x.close <= x.open) throw bad('Closing time must be after opening time');
        out[d] = { closed: false, open: x.open, close: x.close };
      }
      rows.push(['business.hours', out]);
    }
    if (b.rules !== undefined) {
      const rmap = { defaultReturnDays: 'status.default_return_days', lapsedDays: 'status.lapsed_days', winbackDays: 'status.winback_days', inactiveDays: 'status.inactive_days', vipMinSpend: 'vip.min_spend', vipMinVisits: 'vip.min_visits' };
      const cur = await loadBusiness(db), next = { ...cur.rules };
      for (const [f, key] of Object.entries(rmap)) {
        if (b.rules[f] === undefined) continue;
        const n = Number(b.rules[f]), [lo, hi] = NUM_KEYS[key];
        if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`Enter a number between ${lo} and ${hi} for ${f}`);
        next[f] = n; rows.push([key, n]);
      }
      if (!(next.lapsedDays < next.winbackDays && next.winbackDays < next.inactiveDays)) throw bad('The day counts must increase: Lapsed, then Win-back, then Inactive');
    }
    if (!rows.length) throw bad('Nothing to save');
    await tx({ userId: req.user.id, reason: branchId === null ? 'Change business settings' : `Change business settings for branch ${branchId}` }, async (c) => {
      if (branchId !== null) {
        const br = await c.query('SELECT 1 FROM branches WHERE id = $1', [branchId]); if (!br.rowCount) throw bad('Branch not found');
        if (!req.user.permissions.has('branches.manage') && !req.user.branchIds.includes(branchId)) throw new AppError(403, 'WRONG_BRANCH', 'You are not assigned to this branch');
      }
      const global = branchId === null ? null : Object.fromEntries((await c.query(`SELECT key, value FROM app_settings WHERE branch_id IS NULL AND key LIKE 'business.%'`)).rows.map((x) => [x.key, x.value]));
      for (const [k, val] of rows) {
        // for a branch: a blank value, or one equal to the salon-wide value, means "no override" (the branch just follows the salon-wide setting)
        if (branchId !== null && (val === '' || JSON.stringify(val) === JSON.stringify(global[k] ?? ''))) {
          await c.query('DELETE FROM app_settings WHERE branch_id = $1 AND key = $2', [branchId, k]); continue; }
        await c.query(`INSERT INTO app_settings (branch_id, key, value, updated_by) VALUES ($4, $1, $2::jsonb, $3)
                       ON CONFLICT (COALESCE(branch_id, 0), key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [k, JSON.stringify(val), req.user.id, branchId]);
      }
    });
    res.json(await loadBusiness(db, branchId));
  });
}
