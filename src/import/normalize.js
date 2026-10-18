// Turning messy spreadsheet text into clean values.
const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const normName = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export const cleanName = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t && (t === t.toUpperCase() || t === t.toLowerCase()) ? t.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : t;
};

export const FIELDS = {
  customer: ['customer', 'customername', 'client', 'clientname', 'name', 'fullname'],
  phone: ['phone', 'phonenumber', 'contact', 'mobile', 'mobilenumber', 'tel', 'telephone', 'whatsapp', 'cell'],
  date: ['date', 'visitdate', 'servicedate', 'day', 'saledate', 'transactiondate'],
  technician: ['technician', 'tech', 'stylist', 'staff', 'servedby', 'employee', 'beautician', 'attendant', 'techniciansname'],
  service: ['service', 'services', 'item', 'treatment', 'servicename', 'servicerendered'],
  amount: ['amount', 'price', 'total', 'cost', 'paid', 'ksh', 'kes', 'value', 'charge', 'servicecost', 'amountpaid'],
  payment: ['paymentmethod', 'payment', 'modeofpayment', 'method', 'paymode', 'mode', 'paidvia', 'paymenttype'],
  materials: ['materialused', 'materialsused', 'materials', 'material', 'productsused', 'productused'],
  branch: ['branch', 'location', 'outlet', 'shop'],
};
export const REQUIRED = ['customer', 'date', 'service', 'amount'];

/** Match spreadsheet headers to fields. `override` = { field: 'Header text' } wins over guessing. */
export function mapHeaders(headers, override = {}) {
  const map = {}, used = new Set(), keys = headers.map(key);
  for (const [f, h] of Object.entries(override || {})) { const i = headers.findIndex((x) => x === h); if (i >= 0) { map[f] = i; used.add(i); } }
  const pass = (test) => { for (const [f, syn] of Object.entries(FIELDS)) {
    if (map[f] !== undefined) continue;
    const i = keys.findIndex((k, idx) => !used.has(idx) && k && syn.some((s) => test(k, s)));
    if (i >= 0) { map[f] = i; used.add(i); } } };
  pass((k, s) => k === s);
  pass((k, s) => s.length >= 4 && k.startsWith(s));
  return { map, unmatchedHeaders: headers.filter((h, i) => h && !used.has(i)) };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};
/** Returns 'YYYY-MM-DD' or null. Understands Excel serial numbers, ISO, 5/10/2026 (day first by default) and "5 Oct 2026". */
export function parseDate(v, { dateFormat = 'dmy' } = {}) {
  const s = String(v ?? '').trim(); if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s) && +s > 20000 && +s < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 864e5).toISOString().slice(0, 10);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s); if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(s);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return dateFormat === 'mdy' ? iso(y, +m[1], +m[2]) : iso(y, +m[2], +m[1]); }
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/]+([A-Za-z]{3,9})\.?,?[\s\-/]+(\d{2}|\d{4})$/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return iso(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  return null;
}
/** Returns integer cents or null. Handles "Ksh 1,000", "1000/=", "1 000.50". */
export function parseAmount(v) {
  let s = String(v ?? '').trim().toLowerCase(); if (!s) return null;
  s = s.replace(/ksh?s?\.?|kes|\/=|\/-|=/g, '').replace(/[\s,]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const c = Math.round(parseFloat(s) * 100); return Number.isFinite(c) ? c : null;
}
/** Same rules as the database function normalize_ke_phone, so matches agree. */
export function normPhone(v) {
  let d = String(v ?? '').trim().replace(/\.0+$/, '').replace(/[^0-9]/g, '');
  if (/^254[17]\d{8}$/.test(d)) return d;
  if (/^0[17]\d{8}$/.test(d)) return '254' + d.slice(1);
  if (/^[17]\d{8}$/.test(d)) return '254' + d;
  return null;
}
export function parseMethod(v) {
  const s = key(v); if (!s) return null;
  if (/mpesa|mpes|safaricom|till|paybill/.test(s)) return 'mpesa';
  if (/cash/.test(s)) return 'cash';
  if (/card|visa|mastercard|pos/.test(s)) return 'card';
  if (/bank|transfer|eft|cheque|check/.test(s)) return 'bank';
  return 'other';
}
const UNIT = /^(?:packs?|pcs?|pieces?|bottles?|units?|sets?|tubes?|jars?|of)\b\s*/i;
/** "Braids x2; Gel x1", "2 packs braids", "Braids (2)", "Braids" -> [{ name, qty }] */
export function parseMaterials(v) {
  const out = [];
  for (let part of String(v ?? '').split(/[;,|\n]+/)) {
    part = part.trim(); if (!part) continue;
    let m = /^(.*?)\s*(?:x|×|\*|:|=)\s*(\d+(?:\.\d+)?)$/i.exec(part) || /^(.*?)\s*\(\s*(\d+(?:\.\d+)?)\s*\)$/.exec(part);
    if (m) { out.push({ name: m[1].trim(), qty: +m[2] }); continue; }
    m = /^(\d+(?:\.\d+)?)\s*(?:x|×)?\s*(.+)$/i.exec(part);
    if (m) { let name = m[2].trim(); while (UNIT.test(name)) name = name.replace(UNIT, ''); out.push({ name, qty: +m[1] }); continue; }
    out.push({ name: part, qty: 1 });
  }
  return out.filter((x) => x.name && x.qty > 0);
}
export const weekStart = (d) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 1) % 7)); return t.toISOString().slice(0, 10); };
export const namesCompatible = (a, b) => { const x = normName(a), y = normName(b); return !x || !y || x === y || x.includes(y) || y.includes(x) || x.split(' ')[0] === y.split(' ')[0]; };
export const similar = (name, candidates) => { const n = normName(name); return candidates.filter((c) => { const k = normName(c); return k.includes(n) || n.includes(k) || (n.length >= 3 && k.startsWith(n.slice(0, 3))); }).slice(0, 3); };
