import { toCents, allocate, mulBps } from '../lib/money.js';
import { resolveRule, calculateCommission } from '../commission/engine.js';
import { AppError } from '../errors.js';

const METHODS = ['mpesa', 'cash', 'card', 'bank', 'other'];

/**
 * Pure planning step: cart + reference data -> priced lines, material costs, FROZEN commission
 * calculations and totals. No database access, so it is fully unit-testable. The DB layer loads
 * `ctx`, calls this, then stores the result in one transaction.
 */
export function planSale(input, ctx) {
  const S = { commissionBasis: 'net', discountApprovalPct: 15, varianceFlagPct: 25, ...ctx.settings };
  const items = [];
  let pkgGroup = 0;

  const need = (map, id, what) => {
    const v = map.get(Number(id));
    if (!v) throw new AppError(422, 'UNKNOWN_' + what.toUpperCase(), `${what} ${id} not found or unavailable`);
    return v;
  };
  const checkTech = (techId, serviceId) => {
    if (!ctx.technicians) return;
    const t = ctx.technicians.get(Number(techId));
    if (!t) throw new AppError(422, 'UNKNOWN_TECHNICIAN', `Technician ${techId} not found`);
    if (!t.is_active) throw new AppError(422, 'TECHNICIAN_INACTIVE', `${t.display_name} is inactive`);
    if (t.eligible_service_ids?.length && !t.eligible_service_ids.includes(Number(serviceId)))
      throw new AppError(422, 'TECHNICIAN_NOT_ELIGIBLE', `${t.display_name} is not eligible for service ${serviceId}`);
  };
  const materialsFor = (serviceId, override) => {
    const expected = ctx.serviceMaterials.get(Number(serviceId)) || [];
    const actual = new Map();
    if (override) override.forEach((m) => actual.set(Number(m.productId), Number(m.qty)));
    else expected.forEach((m) => actual.set(Number(m.product_id), Number(m.default_qty)));
    const rows = [];
    for (const [pid, qty] of actual) {
      if (!(qty > 0)) continue;
      const p = need(ctx.products, pid, 'product');
      const exp = Number(expected.find((e) => Number(e.product_id) === pid)?.default_qty || 0);
      rows.push({ product_id: pid, name: p.name, expected_qty: exp, actual_qty: qty, unit_cost_cents: p.unit_cost_cents,
        total_cost_cents: Math.round(qty * p.unit_cost_cents),            // ACTUAL qty x unit cost frozen now
        variance_flag: exp > 0 && qty > exp * (1 + S.varianceFlagPct / 100) });
    }
    return rows;
  };
  // Materials cost typed in at the till (a single KSh amount for the line). Blank = not entered.
  const manualMaterials = (raw, name) => {
    if (raw == null || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new AppError(422, 'BAD_MATERIALS', `Materials cost for ${name} must be a number of 0 or more`);
    return toCents(n);
  };
  const serviceItem = (svc, techId, gross, list, extra = {}) => {
    checkTech(techId, svc.id);
    return { item_type: 'service', service_id: svc.id, category_id: svc.category_id, technician_id: Number(techId),
      description: svc.name, quantity: 1, list_cents: list, gross_cents: gross, discount_cents: 0, materials: [], ...extra };
  };

  // 1) expand cart lines
  for (const line of input.lines || []) {
    if (line.kind === 'service') {
      const svc = need(ctx.services, line.serviceId, 'service');
      const it = serviceItem(svc, line.technicianId, svc.price_cents, svc.price_cents, { manual_material_cents: manualMaterials(line.materialsCost, svc.name) });
      if (line.collabTechnicianId != null && line.collabTechnicianId !== '') {            // "collabo": a second hairdresser; the commission is shared equally
        if (svc.category_code && svc.category_code !== 'HAIR') throw new AppError(422, 'COLLAB_HAIR_ONLY', `${svc.name} is not a hair service, so it cannot be shared between two people`);
        if (Number(line.collabTechnicianId) === Number(line.technicianId)) throw new AppError(422, 'COLLAB_SAME_PERSON', `Choose two different hairdressers for ${svc.name}`);
        checkTech(line.collabTechnicianId, svc.id);
        it.collab_technician_id = Number(line.collabTechnicianId);
      }
      it.materials = materialsFor(svc.id, line.materials);
      items.push(it);
    } else if (line.kind === 'package') {
      const pkg = need(ctx.packages, line.packageId, 'package');
      pkgGroup += 1;
      const parts = pkg.items.flatMap((pi) => Array.from({ length: pi.quantity }, () => pi));
      const lists = parts.map((pi) => pi.individual_value_cents ?? need(ctx.services, pi.service_id, 'service').price_cents);
      const shares = allocate(pkg.price_cents, lists);                    // package price split pro-rata
      parts.forEach((pi, i) => {
        const svc = need(ctx.services, pi.service_id, 'service');
        const tech = line.technicianByService?.[pi.service_id] ?? line.technicianId;
        const it = serviceItem(svc, tech, shares[i], lists[i], { package_id: pkg.id, package_group: pkgGroup,
          pkg_commission_basis: pkg.commission_basis, manual_material_cents: manualMaterials(line.materialsCostByService?.[pi.service_id], svc.name) });
        it.materials = materialsFor(svc.id, line.materials?.[pi.service_id]);
        items.push(it);
      });
    } else if (line.kind === 'product') {
      const p = need(ctx.products, line.productId, 'product');
      const q = Number(line.qty || 1);
      items.push({ item_type: 'product', product_id: p.id, technician_id: null, description: p.name, quantity: q,
        list_cents: p.selling_price_cents, gross_cents: Math.round(p.selling_price_cents * q), discount_cents: 0, materials: [] });
    } else throw new AppError(422, 'BAD_LINE', `Unknown line kind ${line.kind}`);
  }
  if (!items.length) throw new AppError(422, 'EMPTY_SALE', 'Add at least one service or product');

  // 2) discounts, spread pro-rata over lines
  const subtotal = items.reduce((a, i) => a + i.gross_cents, 0);
  const discounts = [];
  for (const d of input.discounts || []) {
    const isPct = d.type === 'percent';
    const amount = Math.min(isPct ? mulBps(subtotal, Math.round(d.value * 100)) : toCents(d.value), subtotal);
    const pct = subtotal ? (amount / subtotal) * 100 : 0;
    if (!d.reason) throw new AppError(422, 'DISCOUNT_REASON_REQUIRED', 'Every discount needs a reason');
    if (pct > S.discountApprovalPct && !input.discountApprovedBy)
      throw new AppError(403, 'DISCOUNT_APPROVAL_REQUIRED', `Discounts above ${S.discountApprovalPct}% need manager approval`);
    discounts.push({ discount_type: d.type, value: d.value, is_percent: isPct, amount_cents: amount, reason: d.reason,
      definition_id: d.definitionId ?? null });
  }
  const discountTotal = Math.min(discounts.reduce((a, d) => a + d.amount_cents, 0), subtotal);
  allocate(discountTotal, items.map((i) => i.gross_cents)).forEach((x, k) => { items[k].discount_cents = x; });
  items.forEach((i) => { i.net_cents = i.gross_cents - i.discount_cents; });

  // 3) materials + frozen commissions
  const running = new Map(ctx.priorBase || []);
  for (const it of items) {
    it.material_cents = it.manual_material_cents ?? it.materials.reduce((a, m) => a + m.total_cost_cents, 0);
    if (it.item_type !== 'service') { it.commission = null; continue; }
    if (it.manual_material_cents > it.gross_cents) throw new AppError(422, 'MATERIALS_TOO_HIGH', `Materials cost for ${it.description} is more than the service price`);
    let price = S.commissionBasis === 'list' ? it.gross_cents : it.net_cents;
    if (it.pkg_commission_basis === 'list_price') price = it.list_cents;
    const rule = resolveRule(ctx.rules, { technicianId: it.technician_id, serviceId: it.service_id,
      categoryId: it.category_id, onDate: ctx.businessDate });
    if (rule.calc_type === 'percent_after_materials' && it.manual_material_cents === undefined && !it.materials.length)
      throw new AppError(422, 'MATERIALS_REQUIRED', `Enter the materials cost for ${it.description} (type 0 if none)`);
    const prior = running.get(it.technician_id) || 0;
    const c = calculateCommission(rule, { priceCents: price, materialCents: it.material_cents, priorBaseCents: prior });
    running.set(it.technician_id, prior + c.baseCents);
    it.commission = { ...c, ruleId: rule.id, priceCents: price };
    if (it.collab_technician_id) {
      // The commission worked out for the service is shared 50/50. An odd cent goes to the first hairdresser.
      const half = (n) => { const b = Math.floor(n / 2); return [n - b, b]; };
      const [a1, a2] = half(c.amountCents), [b1, b2] = half(c.baseCents), [p1, p2] = half(price), [m1, m2] = half(it.material_cents);
      const part = (techId, amount, base, pr, mat) => ({ ...c, technician_id: techId, ruleId: rule.id, amountCents: amount, baseCents: base, priceCents: pr, materialCents: mat,
        snapshot: { ...c.snapshot, collab: true, share: 0.5, full_amount_cents: c.amountCents } });
      it.commission.parts = [part(it.technician_id, a1, b1, p1, m1), part(it.collab_technician_id, a2, b2, p2, m2)];
      running.set(it.technician_id, prior + b1);
      running.set(it.collab_technician_id, (running.get(it.collab_technician_id) || 0) + b2);
    }
  }

  // 4) totals and payments
  const total = subtotal - discountTotal;
  const payments = (input.payments || []).map((p) => {
    if (!METHODS.includes(p.method)) throw new AppError(422, 'BAD_METHOD', `Unknown payment method ${p.method}`);
    return { method: p.method, amount_cents: toCents(p.amount), reference: p.reference ?? null };
  });
  const paid = payments.reduce((a, p) => a + p.amount_cents, 0);
  if (paid > total) throw new AppError(422, 'OVERPAYMENT', 'Payments exceed the total; record change given separately');
  if (paid < total && !input.allowPartial) throw new AppError(422, 'UNDERPAYMENT', 'Payments do not cover the total');

  return { items, discounts, payments,
    totals: { subtotal, discount: discountTotal, total, paid, balance: total - paid },
    commissionTotal: items.reduce((a, i) => a + (i.commission?.amountCents || 0), 0),
    materialTotal: items.reduce((a, i) => a + i.material_cents, 0) };
}
