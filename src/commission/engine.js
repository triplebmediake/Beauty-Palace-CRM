import { toBps, toCents, mulBps } from '../lib/money.js';
import { AppError } from '../errors.js';

// Precedence, highest first. 'technician' is an optional per-person override below technician+service.
export const SCOPE_RANK = { technician_service: 4, technician: 3, service: 2, category: 1, default: 0 };

const eq = (a, b) => a != null && b != null && String(a) === String(b);
const matches = (r, c) => {
  switch (r.scope) {
    case 'default': return true;
    case 'category': return eq(r.category_id, c.categoryId);
    case 'service': return eq(r.service_id, c.serviceId);
    case 'technician': return eq(r.technician_id, c.technicianId);
    case 'technician_service': return eq(r.technician_id, c.technicianId) && eq(r.service_id, c.serviceId);
    default: return false;
  }
};

/** Pick the winning rule for a technician + service on a date ('YYYY-MM-DD'). */
export function resolveRule(rules, { technicianId, serviceId, categoryId, onDate }) {
  const hits = rules.filter((r) =>
    r.is_active !== false && r.effective_from <= onDate && (!r.effective_to || r.effective_to > onDate) &&
    matches(r, { technicianId, serviceId, categoryId }));
  if (!hits.length) throw new AppError(422, 'NO_COMMISSION_RULE', 'No commission rule applies (a default rule must exist)');
  hits.sort((a, b) =>
    SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope] ||
    (a.effective_from < b.effective_from ? 1 : a.effective_from > b.effective_from ? -1 : 0) ||
    Number(b.id) - Number(a.id));
  return hits[0];
}

/**
 * One commission, integer cents in and out.
 *  percent_of_price: rate x price | percent_after_materials: rate x (price - materials), floor 0
 *  fixed: fixed amount | tiered: marginal rates over the technician's period-to-date base
 */
export function calculateCommission(rule, { priceCents, materialCents = 0, priorBaseCents = 0 }) {
  const price = Math.max(0, priceCents), mat = Math.max(0, materialCents);
  const snapshot = { rule_id: rule.id ?? null, scope: rule.scope, calc_type: rule.calc_type, rate: rule.rate ?? null,
    fixed_amount: rule.fixed_amount ?? null, tiers: rule.tiers ?? null, tier_base: rule.tier_base ?? null,
    effective_from: rule.effective_from };
  let base, amount, rateBps = null;
  switch (rule.calc_type) {
    case 'percent_of_price': base = price; rateBps = toBps(rule.rate); amount = mulBps(base, rateBps); break;
    case 'percent_after_materials': base = Math.max(0, price - mat); rateBps = toBps(rule.rate); amount = mulBps(base, rateBps); break;
    case 'fixed': base = price; amount = toCents(rule.fixed_amount); break;
    case 'tiered': {
      base = rule.tier_base === 'after_materials' ? Math.max(0, price - mat) : price;
      const tiers = [...rule.tiers].sort((a, b) => (a.up_to ?? Infinity) - (b.up_to ?? Infinity));
      let lower = 0, numerator = 0;
      const from = priorBaseCents, to = priorBaseCents + base;
      for (const t of tiers) {
        const upper = t.up_to == null ? Infinity : toCents(t.up_to);
        numerator += Math.max(0, Math.min(upper, to) - Math.max(lower, from)) * toBps(t.rate);
        lower = upper;
      }
      amount = Math.round(numerator / 10000);
      rateBps = base ? Math.round((amount / base) * 10000) : 0;
      break;
    }
    default: throw new AppError(500, 'BAD_RULE', `Unknown calc_type ${rule.calc_type}`);
  }
  return { calcType: rule.calc_type, baseCents: base, materialCents: mat, rateBps, amountCents: amount, snapshot };
}
