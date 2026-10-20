// Pure planning for a historical import: no database access, so it is fully testable.
// Rows -> cleaned rows -> customers (matched or new) -> VISITS (one per customer per day) -> frozen commissions.
import { createHash } from 'node:crypto';
import { mapHeaders, REQUIRED, parseDate, parseAmount, normPhone, parseMethod, parseMaterials, normName, cleanName, weekStart, namesCompatible, similar } from './normalize.js';
import { resolveRule, calculateCommission } from '../commission/engine.js';

export const DEFAULTS = { dateFormat: 'dmy', createServices: false, createTechnicians: false, unknownMaterials: 'error', skipInvalidRows: false,
  onOverlap: 'skip', branchId: null, defaultTechnicianId: null, serviceAliases: {}, technicianAliases: {}, mapping: {}, paidBefore: null };
const CAT_WORDS = [['HAIR', /hair|braid|weave|twist|cornrow|loc|wig|relax|silk|plait|knotless|crochet|dread|bob|blowdry|blow dry/], ['NAILS', /nail|tips?|gel|pedi|mani|acrylic|builder|polish|overlay|dip/],
  ['LASHES', /lash/], ['MASSAGE', /massage|spa/], ['WAXING', /wax/], ['BROWS', /brow/], ['FACIAL', /facial|face/], ['MAKEUP', /make ?up/], ['PIERCING', /pierc/]];
export const guessCategory = (n) => (CAT_WORDS.find(([, re]) => re.test(String(n).toLowerCase())) || ['OTHER'])[0];
const slug = (n) => normName(n).toUpperCase().replace(/ /g, '_').slice(0, 24) || 'SERVICE';

export function planImport(table, ref, options = {}) {
  const O = { ...DEFAULTS, ...options }, today = ref.today;
  const paidBefore = O.paidBefore || weekStart(today);
  const errors = [], warnings = [];
  const err = (row, message) => errors.push({ row, message });
  const warn = (row, message) => warnings.push({ row, message });

  const hm = mapHeaders(table.headers, O.mapping), col = hm.map;
  const missing = REQUIRED.filter((f) => col[f] === undefined);
  if (col.technician === undefined && !O.defaultTechnicianId) missing.push('technician');
  if (missing.length) return { fatal: { code: 'MISSING_COLUMNS', message: `Could not find column(s): ${missing.join(', ')}`, headers: table.headers, missing }, errors, warnings, visits: [] };
  const get = (cells, f) => (col[f] === undefined ? '' : cells[col[f]] ?? '');

  // ---- lookups
  const svcBy = new Map(); ref.services.forEach((s) => { svcBy.set(normName(s.name), s); svcBy.set(normName(s.code), s); });
  Object.entries(O.serviceAliases).forEach(([a, t]) => { const s = svcBy.get(normName(t)); if (s) svcBy.set(normName(a), s); });
  const techList = ref.technicians; const techBy = new Map(techList.map((t) => [normName(t.display_name), t]));
  Object.entries(O.technicianAliases).forEach(([a, t]) => { const x = techBy.get(normName(t)); if (x) techBy.set(normName(a), x); });
  const branchBy = new Map(); ref.branches.forEach((b) => { branchBy.set(normName(b.code), b); branchBy.set(normName(b.name), b); });
  const defaultBranch = O.branchId ? ref.branches.find((b) => b.id === O.branchId) : ref.branches.length === 1 ? ref.branches[0] : null;
  const catId = new Map(ref.categories.map((c) => [c.code, c.id]));
  const newServices = new Map(), newTechs = new Map(), unknown = { services: new Map(), technicians: new Map(), products: new Map(), branches: new Map() };
  const bump = (m, k, extra) => { const e = m.get(k) || { name: k, count: 0, ...extra }; e.count++; m.set(k, e); };

  const findTech = (name) => {
    const k = normName(name); if (techBy.has(k)) return techBy.get(k);
    const hits = techList.filter((t) => normName(t.display_name).split(' ')[0] === k.split(' ')[0] && k);
    return hits.length === 1 ? hits[0] : null;
  };
  const findProduct = (name) => {
    const k = normName(name); const exact = ref.products.find((p) => normName(p.name) === k || normName(p.sku) === k); if (exact) return exact;
    const hits = ref.products.filter((p) => normName(p.name).includes(k) || k.includes(normName(p.name)));
    return hits.length === 1 ? hits[0] : null;
  };

  // ---- pass 1: clean each row
  const clean = [];
  for (const { n, cells } of table.rows) {
    if (cells.every((c) => !String(c).trim())) continue;
    const rowErrs = [];
    const name = cleanName(get(cells, 'customer')), phoneRaw = get(cells, 'phone'), phoneNorm = normPhone(phoneRaw);
    const date = parseDate(get(cells, 'date'), O), amount = parseAmount(get(cells, 'amount'));
    const svcName = String(get(cells, 'service')).replace(/\s+/g, ' ').trim(), techName = String(get(cells, 'technician')).replace(/\s+/g, ' ').trim();
    if (!name) rowErrs.push('Customer name is empty');
    if (!date) rowErrs.push(`Date "${get(cells, 'date')}" is not recognised (expected e.g. 05/10/2026 or 2026-10-05)`);
    else if (date > today) rowErrs.push(`Date ${date} is in the future`); else if (date < '2000-01-01') rowErrs.push(`Date ${date} is too old to be right`);
    if (amount === null) rowErrs.push(`Amount "${get(cells, 'amount')}" is not a number`); else if (amount <= 0) rowErrs.push('Amount must be more than 0');
    if (!svcName) rowErrs.push('Service is empty');
    if (phoneRaw && !phoneNorm) warn(n, `Phone "${phoneRaw}" is not a valid Kenyan number; matching this customer by name only`);
    if (rowErrs.length) { rowErrs.forEach((m) => err(n, m)); continue; }
    clean.push({ n, name, phoneNorm, phoneRaw: phoneNorm ? phoneRaw : '', date, amount, svcName, techName, methodRaw: get(cells, 'payment'), matText: get(cells, 'materials'), branchText: get(cells, 'branch') });
  }

  // ---- pass 2: resolve service / technician / branch / materials
  const rows = [];
  for (const r of clean) {
    const bad = [];
    let branch = defaultBranch;
    if (col.branch !== undefined && r.branchText) { branch = branchBy.get(normName(r.branchText)); if (!branch) { bad.push(`Branch "${r.branchText}" not found`); bump(unknown.branches, r.branchText); } }
    if (!branch) bad.push('No branch: choose a default branch for this import');
    let svc = svcBy.get(normName(r.svcName));
    if (!svc) {
      if (O.createServices) {
        const k = normName(r.svcName);
        if (!newServices.has(k)) newServices.set(k, { id: null, isNew: true, name: r.svcName, code: slug(r.svcName), category_code: guessCategory(r.svcName), category_id: catId.get(guessCategory(r.svcName)) ?? null, amounts: [] });
        svc = newServices.get(k); svc.amounts.push(r.amount);
      } else { bad.push(`Service "${r.svcName}" is not in your service list`); bump(unknown.services, r.svcName, { suggestions: similar(r.svcName, ref.services.map((s) => s.name)) }); }
    }
    let tech = null;
    if (!r.techName && O.defaultTechnicianId) tech = techList.find((t) => t.id === O.defaultTechnicianId);
    else if (!r.techName) bad.push('Technician is empty');
    else { tech = findTech(r.techName);
      if (!tech) { if (O.createTechnicians) { const k = normName(r.techName); if (!newTechs.has(k)) newTechs.set(k, { id: null, isNew: true, display_name: r.techName, branch_id: branch?.id ?? null }); tech = newTechs.get(k); }
        else { bad.push(`Technician "${r.techName}" is not in your staff list`); bump(unknown.technicians, r.techName, { suggestions: similar(r.techName, techList.map((t) => t.display_name)) }); } } }
    const materials = [];
    // A plain amount (220, "KSh 1,200") = materials bought for this job, entered as money instead of stock items.
    const manualMaterialCents = /^\s*(?:ksh?s?\.?|kes)?\s*\d[\d,]*(?:\.\d+)?\s*(?:\/=|\/-)?\s*$/i.test(String(r.matText ?? '')) ? parseAmount(r.matText) : null;
    if (manualMaterialCents !== null && manualMaterialCents > r.amount) bad.push(`Materials cost ${manualMaterialCents / 100} is more than the service amount`);
    for (const m of manualMaterialCents !== null ? [] : parseMaterials(r.matText)) {
      const p = findProduct(m.name);
      if (p) materials.push({ product: p, qty: m.qty, costCents: Math.round(m.qty * p.unit_cost_cents) });
      else { bump(unknown.products, m.name, { suggestions: similar(m.name, ref.products.map((x) => x.name)) });
        if (O.unknownMaterials === 'error') bad.push(`Material "${m.name}" is not in your inventory list`); else warn(r.n, `Material "${m.name}" not found; its cost is counted as 0`); }
    }
    if (bad.length) { bad.forEach((m) => err(r.n, m)); continue; }
    const method = parseMethod(r.methodRaw); if (!method) warn(r.n, 'No payment method given; recorded as "other"');
    rows.push({ ...r, branch, svc, tech, materials, manualMaterialCents, method: method || 'other' });
  }

  // ---- pass 3: customers (match existing, merge within file, else create)
  const phoneOfName = new Map();                       // name seen WITH a phone in this file -> that phone
  rows.filter((r) => r.phoneNorm).forEach((r) => { const k = normName(r.name); if (!phoneOfName.has(k)) phoneOfName.set(k, new Set()); phoneOfName.get(k).add(r.phoneNorm); });
  const customers = new Map(), newCustomers = [], warnedPair = new Set(), badKeys = new Map();
  const resolveCustomer = (r) => {
    let phone = r.phoneNorm;
    if (!phone) { const s = phoneOfName.get(normName(r.name)); if (s && s.size === 1) phone = [...s][0]; }
    const id = phone ? 'p:' + phone : 'n:' + normName(r.name);
    if (customers.has(id)) return customers.get(id);
    if (badKeys.has(id)) return null;
    let c;
    if (phone) {
      const hit = ref.byPhone.get(phone);
      if (hit) { c = { id: hit.id, name: hit.full_name, existing: true };
        if (!namesCompatible(hit.full_name, r.name)) warn(r.n, `Phone ${phone} belongs to "${hit.full_name}" in your system but the sheet says "${r.name}"; treated as the same customer`); }
      else {
        const same = (ref.byName.get(normName(r.name)) || []).filter((x) => !x.phone_normalized);
        if (same.length === 1) c = { id: same[0].id, name: same[0].full_name, existing: true, fillPhone: phone, phoneRaw: r.phoneRaw };
        else { c = { id: null, name: r.name, phone, phoneRaw: r.phoneRaw, newCustomer: true, firstDate: r.date }; newCustomers.push(c);
          if ((ref.byName.get(normName(r.name)) || []).length) warn(r.n, `A customer named "${r.name}" exists with a different phone; kept as a separate customer`); }
      }
    } else {
      const same = ref.byName.get(normName(r.name)) || [];
      if (same.length > 1) { badKeys.set(id, true); err(r.n, `${same.length} customers are named "${r.name}". Add a phone number so they can be told apart`); return null; }
      if (same.length === 1) c = { id: same[0].id, name: same[0].full_name, existing: true };
      else { c = { id: null, name: r.name, phone: null, newCustomer: true, firstDate: r.date }; newCustomers.push(c); warn(r.n, `"${r.name}" has no phone number; matched by name only`); }
    }
    customers.set(id, c); return c;
  };
  const resolved = [];
  for (const r of rows) { const c = resolveCustomer(r); if (c) resolved.push({ ...r, customer: c }); else if (!errors.some((e) => e.row === r.n)) err(r.n, 'Customer could not be matched'); }
  resolved.forEach((r) => { if (r.customer.newCustomer && r.date < r.customer.firstDate) r.customer.firstDate = r.date; });

  // ---- pass 4: group into visits (ONE customer + ONE day + ONE branch = ONE visit, many service lines)
  const groups = new Map();
  for (const r of resolved) {
    const cid = r.customer.id ?? r.customer; const gk = [r.branch.id, r.date, r.customer.id ?? 'new:' + (r.customer.phone || normName(r.customer.name))].join('|');
    if (!groups.has(gk)) groups.set(gk, { branch: r.branch, date: r.date, customer: r.customer, lines: [], gk }); void cid;
    groups.get(gk).lines.push(r);
  }
  const visits = []; let duplicates = 0, overlaps = 0; const overlapList = [];
  for (const g of [...groups.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.gk < b.gk ? -1 : 1))) {
    const sig = g.lines.map((l) => `${l.svc.name}~${l.tech.display_name}~${l.amount}`).sort().join('^');
    // the key comes from what is in the FILE (phone, else name), not from the customer record, so uploading the same file again is recognised after the customers exist
    const importKey = createHash('sha1').update(`${g.branch.id}|${g.date}|${g.lines.find((l) => l.phoneNorm)?.phoneNorm ?? normName(g.lines[0].name)}|${sig}`).digest('hex');
    if (ref.importKeys.has(importKey)) { duplicates++; continue; }
    if (g.customer.id && O.onOverlap === 'skip' && ref.existingSales.has(`${g.customer.id}|${g.date}`)) { overlaps++; overlapList.push({ customer: g.customer.name, date: g.date }); continue; }
    g.importKey = importKey; visits.push(g);
  }

  // ---- pass 5: frozen commissions, using the rule that applied on each date
  const running = new Map();
  const techKey = (t) => t.id ?? 'new:' + t.display_name;
  for (const v of visits) {
    v.payments = new Map(); v.total = 0;
    for (const l of v.lines) {
      l.materialCents = l.manualMaterialCents ?? l.materials.reduce((a, m) => a + m.costCents, 0);
      const rule = resolveRule(ref.rules, { technicianId: l.tech.id, serviceId: l.svc.id, categoryId: l.svc.category_id, onDate: v.date });
      const rk = techKey(l.tech) + '|' + weekStart(v.date), prior = running.get(rk) || 0;
      const c = calculateCommission(rule, { priceCents: l.amount, materialCents: l.materialCents, priorBaseCents: prior });
      running.set(rk, prior + c.baseCents);
      l.commission = { ...c, ruleId: rule.id, priceCents: l.amount, paid: v.date < paidBefore };
      v.total += l.amount; v.payments.set(l.method, (v.payments.get(l.method) || 0) + l.amount);
    }
  }
  const usedNewSvc = new Set(visits.flatMap((v) => v.lines.map((l) => l.svc)).filter((s) => s.isNew));
  const usedNewTech = new Set(visits.flatMap((v) => v.lines.map((l) => l.tech)).filter((t) => t.isNew));
  const usedNewCust = newCustomers.filter((c) => visits.some((v) => v.customer === c));
  usedNewSvc.forEach((s) => { const a = [...s.amounts].sort((x, y) => x - y); s.price_cents = a[Math.floor(a.length / 2)]; });   // median amount becomes the list price
  usedNewTech.forEach((t) => { t.branch_id = visits.find((v) => v.lines.some((l) => l.tech === t)).branch.id; });

  const lines = visits.flatMap((v) => v.lines);
  const dates = visits.map((v) => v.date).sort();
  const summary = {
    rowsRead: table.rows.length, rowsRejected: new Set(errors.map((e) => e.row)).size, visits: visits.length, serviceLines: lines.length,
    customersMatched: new Set(visits.filter((v) => v.customer.existing).map((v) => v.customer.id)).size, customersNew: usedNewCust.length,
    newServices: [...usedNewSvc].map((s) => ({ name: s.name, category: s.category_code, price: s.price_cents / 100 })), newTechnicians: [...usedNewTech].map((t) => t.display_name),
    revenue: lines.reduce((a, l) => a + l.amount, 0) / 100, commission: lines.reduce((a, l) => a + l.commission.amountCents, 0) / 100,
    commissionMarkedPaid: lines.filter((l) => l.commission.paid).reduce((a, l) => a + l.commission.amountCents, 0) / 100,
    commissionLeftPending: lines.filter((l) => !l.commission.paid).reduce((a, l) => a + l.commission.amountCents, 0) / 100,
    materialCost: lines.reduce((a, l) => a + l.materialCents, 0) / 100, paidBefore,
    from: dates[0] ?? null, to: dates.at(-1) ?? null, duplicatesSkipped: duplicates, overlapsSkipped: overlaps,
    newCustomersWithoutPhone: usedNewCust.filter((c) => !c.phone).length,
  };
  return { fatal: null, summary, errors, warnings, visits, newCustomers: usedNewCust, newServices: [...usedNewSvc], newTechnicians: [...usedNewTech], paidBefore,
    unknown: Object.fromEntries(Object.entries(unknown).map(([k, m]) => [k, [...m.values()].sort((a, b) => b.count - a.count)])), overlapList, columnMap: Object.fromEntries(Object.entries(col).map(([f, i]) => [f, table.headers[i]])),
    unmatchedHeaders: hm.unmatchedHeaders };
}
