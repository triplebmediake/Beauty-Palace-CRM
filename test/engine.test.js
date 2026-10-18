import test from 'node:test';
import assert from 'node:assert/strict';
import { planSale } from '../src/sales/plan.js';
import { resolveRule, calculateCommission } from '../src/commission/engine.js';
import { allocate } from '../src/lib/money.js';

const C = (k) => k * 100;
const rules = [
  { id: 1, scope: 'default', calc_type: 'percent_of_price', rate: 0.4, effective_from: '2026-01-01' },
  { id: 2, scope: 'category', category_id: 1, calc_type: 'percent_of_price', rate: 0.4, effective_from: '2026-01-01' },
  { id: 3, scope: 'category', category_id: 2, calc_type: 'percent_after_materials', rate: 0.5, effective_from: '2026-01-01' },
];
const svc = (id, name, cat, price) => [id, { id, name, category_id: cat, price_cents: C(price) }];
const prod = (id, name, cost) => [id, { id, name, unit_cost_cents: C(cost), selling_price_cents: C(cost * 2) }];
const ctxBase = (over = {}) => ({ businessDate: '2026-10-05', rules,
  services: new Map([svc(1, 'TIPS', 1, 1000), svc(2, 'PEDI', 1, 800), svc(3, 'Hair', 2, 3000), svc(4, 'Big Hair', 2, 5000)]),
  products: new Map([prod(10, 'Braids', 150), prod(11, 'Braids 300', 300), prod(12, 'Gel', 200)]),
  serviceMaterials: new Map(), packages: new Map(), settings: {}, ...over });
const pay = (ksh) => [{ method: 'cash', amount: ksh }];
const comm = (plan) => plan.items.map((i) => i.commission?.amountCents / 100);

test('TEST 1 - nail: 40% of 1,000 = 400', () => {
  assert.deepEqual(comm(planSale({ lines: [{ kind: 'service', serviceId: 1, technicianId: 1 }], payments: pay(1000) }, ctxBase())), [400]);
});
test('TEST 2 - hair: 50% x (3,000 - 300) = 1,350', () => {
  const p = planSale({ lines: [{ kind: 'service', serviceId: 3, technicianId: 3, materials: [{ productId: 10, qty: 2 }] }], payments: pay(3000) }, ctxBase());
  assert.equal(p.items[0].material_cents, C(300));
  assert.deepEqual(comm(p), [1350]);
  assert.equal(p.totals.total - p.commissionTotal, C(1650));
});
test('TEST 3 - hair, multiple materials: 5,000 - 800 -> 2,100', () => {
  const p = planSale({ lines: [{ kind: 'service', serviceId: 4, technicianId: 3,
    materials: [{ productId: 11, qty: 2 }, { productId: 12, qty: 1 }] }], payments: pay(5000) }, ctxBase());
  assert.equal(p.items[0].material_cents, C(800));
  assert.equal(p.items[0].commission.baseCents, C(4200));
  assert.deepEqual(comm(p), [2100]);
});
test('TEST 4 - tips + pedi + hair = 2,070 across different technicians, one sale', () => {
  const p = planSale({ lines: [
    { kind: 'service', serviceId: 1, technicianId: 1 }, { kind: 'service', serviceId: 2, technicianId: 2 },
    { kind: 'service', serviceId: 3, technicianId: 3, materials: [{ productId: 10, qty: 2 }] }], payments: pay(4800) }, ctxBase());
  assert.deepEqual(comm(p), [400, 320, 1350]);
  assert.equal(p.commissionTotal, C(2070));
});
test('actual material usage (3 packs) is used, not the expected 2', () => {
  const sm = new Map([[3, [{ product_id: 10, default_qty: 2 }]]]);
  const base = { lines: [{ kind: 'service', serviceId: 3, technicianId: 3 }], payments: pay(3000) };
  assert.deepEqual(comm(planSale(base, ctxBase({ serviceMaterials: sm }))), [1350]);
  const p = planSale({ ...base, lines: [{ ...base.lines[0], materials: [{ productId: 10, qty: 3 }] }] }, ctxBase({ serviceMaterials: sm }));
  assert.deepEqual(comm(p), [1275]);
  assert.equal(p.items[0].materials[0].variance_flag, true);
});
test('rule hierarchy and effective dates', () => {
  const rs = [...rules,
    { id: 4, scope: 'service', service_id: 1, calc_type: 'percent_of_price', rate: 0.45, effective_from: '2026-01-01' },
    { id: 5, scope: 'technician', technician_id: 9, calc_type: 'percent_of_price', rate: 0.5, effective_from: '2026-01-01' },
    { id: 6, scope: 'technician_service', technician_id: 9, service_id: 1, calc_type: 'fixed', fixed_amount: 250, effective_from: '2026-01-01' },
    { id: 7, scope: 'category', category_id: 1, calc_type: 'percent_of_price', rate: 0.35, effective_from: '2026-11-01' }];
  const q = (t, s, c, d = '2026-10-05') => resolveRule(rs, { technicianId: t, serviceId: s, categoryId: c, onDate: d }).id;
  assert.equal(q(9, 1, 1), 6); assert.equal(q(9, 2, 1), 5); assert.equal(q(1, 1, 1), 4);
  assert.equal(q(1, 2, 1), 2); assert.equal(q(1, 2, 7), 1);
  assert.equal(q(1, 2, 1, '2026-11-02'), 7);
});
test('a planned commission is a frozen snapshot; later rule changes do not alter it', () => {
  const p = planSale({ lines: [{ kind: 'service', serviceId: 1, technicianId: 1 }], payments: pay(1000) }, ctxBase());
  const frozen = structuredClone(p.items[0].commission);
  rules[1].rate = 0.9;
  assert.deepEqual(p.items[0].commission, frozen);
  assert.equal(frozen.snapshot.rate, 0.4); rules[1].rate = 0.4;
});
test('package: price split pro-rata; commission on allocated vs list price', () => {
  const pk = (basis) => new Map([[1, { id: 1, price_cents: C(1500), commission_basis: basis,
    items: [{ service_id: 1, quantity: 1 }, { service_id: 2, quantity: 1 }] }]]);
  const run = (b) => planSale({ lines: [{ kind: 'package', packageId: 1, technicianId: 1 }], payments: pay(1500) }, ctxBase({ packages: pk(b) }));
  const a = run('allocated_price');
  assert.equal(a.items[0].gross_cents + a.items[1].gross_cents, C(1500));
  assert.equal(run('list_price').commissionTotal, C(720));
});
test('discount spread over lines, approval threshold, commission basis', () => {
  const lines = [{ kind: 'service', serviceId: 1, technicianId: 1 }, { kind: 'service', serviceId: 2, technicianId: 2 }];
  const p = planSale({ lines, discounts: [{ type: 'percent', value: 10, reason: 'Loyalty' }], payments: pay(1620) }, ctxBase());
  assert.equal(p.totals.total, C(1620)); assert.deepEqual(comm(p), [360, 288]);
  assert.throws(() => planSale({ lines, discounts: [{ type: 'percent', value: 30, reason: 'x' }], payments: pay(1260) }, ctxBase()),
    (e) => e.code === 'DISCOUNT_APPROVAL_REQUIRED');
  assert.deepEqual(comm(planSale({ lines, discounts: [{ type: 'percent', value: 10, reason: 'Loyalty' }], payments: pay(1620) },
    ctxBase({ settings: { commissionBasis: 'list' } }))), [400, 320]);
});
test('split, partial and over payments', () => {
  const lines = [{ kind: 'service', serviceId: 4, technicianId: 3, materialsCost: 0 }];
  const p = planSale({ lines, payments: [{ method: 'mpesa', amount: 3500, reference: 'QWE123' }, { method: 'cash', amount: 1500 }] }, ctxBase());
  assert.equal(p.payments.length, 2); assert.equal(p.totals.balance, 0);
  assert.throws(() => planSale({ lines, payments: pay(1000) }, ctxBase()), (e) => e.code === 'UNDERPAYMENT');
  assert.equal(planSale({ lines, payments: pay(1000), allowPartial: true }, ctxBase()).totals.balance, C(4000));
  assert.throws(() => planSale({ lines, payments: pay(9000) }, ctxBase()), (e) => e.code === 'OVERPAYMENT');
});
test('commission never negative when materials exceed price', () => {
  assert.equal(calculateCommission(rules[2], { priceCents: C(500), materialCents: C(800) }).amountCents, 0);
});
test('tiered: marginal rates over period-to-date base', () => {
  const rule = { id: 9, scope: 'default', calc_type: 'tiered', tier_base: 'price', effective_from: '2026-01-01',
    tiers: [{ up_to: 100000, rate: 0.3 }, { up_to: null, rate: 0.4 }] };
  assert.equal(calculateCommission(rule, { priceCents: C(10000), priorBaseCents: 0 }).amountCents, C(3000));
  assert.equal(calculateCommission(rule, { priceCents: C(10000), priorBaseCents: C(95000) }).amountCents, C(3500));
  assert.equal(calculateCommission(rule, { priceCents: C(10000), priorBaseCents: C(200000) }).amountCents, C(4000));
});
test('allocate always sums exactly', () => {
  for (const [t, w] of [[100, [1, 1, 1]], [150000, [100000, 80000]], [7, [3, 3, 3]], [0, [5, 5]], [999, [0, 0]]])
    assert.equal(allocate(t, w).reduce((a, b) => a + b, 0), t);
});

test('hair materials typed at the till: 50% x (price - materials); needed for hair, recorded frozen', () => {
  const line = (m) => ({ kind: 'service', serviceId: 3, technicianId: 3, ...(m === undefined ? {} : { materialsCost: m }) });
  const p = planSale({ lines: [line(600)], payments: pay(3000) }, ctxBase());
  assert.equal(p.items[0].material_cents, C(600)); assert.equal(p.items[0].commission.baseCents, C(2400)); assert.deepEqual(comm(p), [1200]);
  assert.equal(planSale({ lines: [line('0')], payments: pay(3000) }, ctxBase()).items[0].commission.amountCents, C(1500));      // typed 0 = no materials
  assert.throws(() => planSale({ lines: [line()], payments: pay(3000) }, ctxBase()), (e) => e.code === 'MATERIALS_REQUIRED');
  assert.throws(() => planSale({ lines: [line('')], payments: pay(3000) }, ctxBase()), (e) => e.code === 'MATERIALS_REQUIRED');
  assert.throws(() => planSale({ lines: [line(-5)], payments: pay(3000) }, ctxBase()), (e) => e.code === 'BAD_MATERIALS');
  assert.throws(() => planSale({ lines: [line(3500)], payments: pay(3000) }, ctxBase()), (e) => e.code === 'MATERIALS_TOO_HIGH');
});
test('hair commission after a discount uses the discounted price minus materials', () => {
  const p = planSale({ lines: [{ kind: 'service', serviceId: 3, technicianId: 3, materialsCost: 500 }], discounts: [{ type: 'percent', value: 10, reason: 'Loyal' }], payments: pay(2700) }, ctxBase());
  assert.equal(p.items[0].net_cents, C(2700)); assert.equal(p.items[0].commission.baseCents, C(2200)); assert.deepEqual(comm(p), [1100]);
});
test('nail materials are optional and do not change a percent-of-price commission', () => {
  const p = planSale({ lines: [{ kind: 'service', serviceId: 1, technicianId: 1, materialsCost: 100 }], payments: pay(1000) }, ctxBase());
  assert.equal(p.items[0].material_cents, C(100)); assert.deepEqual(comm(p), [400]);
});

test('COLLABO - two hairdressers share a hair service: the 1,350 commission is split 675 / 675, materials and price halved too', () => {
  const ctx = ctxBase({ services: new Map([[3, { id: 3, name: 'Hair', category_id: 2, category_code: 'HAIR', price_cents: C(3000) }], [1, { id: 1, name: 'TIPS', category_id: 1, category_code: 'NAILS', price_cents: C(1000) }]]) });
  const p = planSale({ lines: [{ kind: 'service', serviceId: 3, technicianId: 3, collabTechnicianId: 4, materials: [{ productId: 10, qty: 2 }] }], payments: pay(3000) }, ctx);
  const it = p.items[0];
  assert.equal(it.commission.amountCents, C(1350));                       // total unchanged
  assert.deepEqual(it.commission.parts.map((x) => [x.technician_id, x.amountCents]), [[3, C(675)], [4, C(675)]]);
  assert.deepEqual(it.commission.parts.map((x) => x.baseCents), [C(1350), C(1350)]);
  assert.equal(it.commission.parts[0].snapshot.collab, true);
  assert.equal(p.commissionTotal, C(1350));
});
test('COLLABO - an odd cent goes to the first hairdresser; same person twice and non-hair services are refused', () => {
  const ctx = ctxBase({ services: new Map([[3, { id: 3, name: 'Hair', category_id: 2, category_code: 'HAIR', price_cents: 300001 }], [1, { id: 1, name: 'TIPS', category_id: 1, category_code: 'NAILS', price_cents: C(1000) }]]) });
  const p = planSale({ lines: [{ kind: 'service', serviceId: 3, technicianId: 3, collabTechnicianId: 4, materialsCost: 0 }], payments: [{ method: 'cash', amount: 3000.01 }] }, ctx);
  const [a, b] = p.items[0].commission.parts.map((x) => x.amountCents);
  assert.equal(a + b, p.items[0].commission.amountCents); assert.ok(a - b <= 1 && a >= b);
  assert.throws(() => planSale({ lines: [{ kind: 'service', serviceId: 3, technicianId: 3, collabTechnicianId: 3, materialsCost: 0 }], payments: pay(3000) }, ctx), /different hairdressers/);
  assert.throws(() => planSale({ lines: [{ kind: 'service', serviceId: 1, technicianId: 1, collabTechnicianId: 2 }], payments: pay(1000) }, ctx), /not a hair service/);
});
