// Wiring smoke test with a STUB database. It checks parameter counts, statement order and the values
// written. It does NOT validate SQL syntax or the schema triggers - that needs a real PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkout } from '../src/sales/checkout.js';

function stubDb({ stock = 40, allowNegative } = {}) {
  const log = []; let id = 100;
  const R = (rows = []) => ({ rows, rowCount: rows.length });
  return { log, async query(sql, params = []) {
    const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))];
    assert.equal(used.length ? Math.max(...used) : 0, params.length, 'param count mismatch in: ' + sql.slice(0, 80));
    log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/business_today/.test(sql)) return R([{ d: '2026-10-05' }]);
    if (/FROM customers WHERE id/.test(sql)) return R([{ id: 5 }]);
    if (/FROM services s/.test(sql)) return R([{ id: 3, name: 'Knotless', category_id: 2, price: '3000.00' }, { id: 1, name: 'TIPS', category_id: 1, price: '1000.00' }]);
    if (/FROM products p/.test(sql)) return R([{ id: 10, name: 'Braids', selling_price: '300', unit_cost: '150.0000' }]);
    if (/FROM service_materials/.test(sql)) return R([{ service_id: 3, product_id: 10, default_qty: '2' }]);
    if (/FROM packages p/.test(sql)) return R([]);
    if (/FROM commission_rules/.test(sql)) return R([
      { id: 1, scope: 'default', calc_type: 'percent_of_price', rate: 0.4, effective_from: '2026-01-01', is_active: true },
      { id: 3, scope: 'category', category_id: 2, calc_type: 'percent_after_materials', rate: 0.5, effective_from: '2026-01-01', is_active: true }]);
    if (/allow_negative_stock/.test(sql)) return R(allowNegative === undefined ? [] : [{ value: allowNegative }]);
    if (/FROM app_settings/.test(sql)) return R([]);
    if (/FROM technicians t/.test(sql)) return R([{ id: 3, display_name: 'Cynthia', is_active: true, elig: [] }, { id: 1, display_name: 'Amina', is_active: true, elig: [] }]);
    if (/FROM commission_calculations/.test(sql)) return R([]);
    if (/INSERT INTO visits/.test(sql)) return R([{ id: 7, is_new_customer: false }]);
    if (/next_receipt_no/.test(sql)) return R([{ r: 'MAIN-2026-000001' }]);
    if (/INSERT INTO inventory \(/.test(sql)) return R();
    if (/FROM inventory WHERE/.test(sql)) return R([{ qty_on_hand: String(stock) }]);
    if (/INSERT INTO (transactions|transaction_items|inventory_transactions)/.test(sql)) return R([{ id: ++id }]);
    return R();
  } };
}
const input = { branchId: 1, customerId: 5,
  lines: [{ kind: 'service', serviceId: 3, technicianId: 3, materials: [{ productId: 10, qty: 2 }] }, { kind: 'service', serviceId: 1, technicianId: 1 }],
  payments: [{ method: 'mpesa', amount: 2500, reference: 'QWE1' }, { method: 'cash', amount: 1500 }] };

test('checkout writes frozen commission, deducts ACTUAL stock, records split payments', async () => {
  const db = stubDb();
  const r = await checkout(db, input, { userId: 9 });
  assert.equal(r.totals.total, 400000);
  assert.equal(r.commissionTotal, 135000 + 40000);
  const cc = db.log.filter((x) => /INSERT INTO commission_calculations/.test(x.sql));
  assert.equal(cc.length, 2);
  assert.equal(cc[0].params[11], '1350.00'); assert.equal(cc[0].params[8], '300.00');        // commission, material cost
  assert.equal(cc[1].params[11], '400.00');
  const inv = db.log.find((x) => /INSERT INTO inventory_transactions/.test(x.sql));
  assert.equal(inv.params[2], 'service_consumption'); assert.equal(inv.params[3], -2);
  assert.equal(db.log.filter((x) => /INSERT INTO payments/.test(x.sql)).length, 2);
  assert.ok(db.log.findIndex((x) => /INSERT INTO visits/.test(x.sql)) < db.log.findIndex((x) => /INSERT INTO transactions/.test(x.sql)));
});
test('short stock: sale still goes through, stock goes negative, alert is raised and returned', async () => {
  const db = stubDb({ stock: 1 });
  const r = await checkout(db, input, { userId: 9 });
  assert.equal(r.totals.total, 400000);
  assert.deepEqual(r.stockWarnings, [{ productId: 10, name: 'Braids', onHand: -1 }]);
  assert.ok(db.log.some((x) => /INSERT INTO alerts/.test(x.sql)));
  assert.equal(db.log.find((x) => /INSERT INTO commission_calculations/.test(x.sql)).params[11], '1350.00');
});
test('enough stock: no warning and no alert', async () => {
  const db = stubDb({ stock: 40 });
  const r = await checkout(db, input, { userId: 9 });
  assert.deepEqual(r.stockWarnings, []);
  assert.ok(!db.log.some((x) => /INSERT INTO alerts/.test(x.sql)));
});
test('setting inventory.allow_negative_stock = false blocks the sale', async () => {
  await assert.rejects(checkout(stubDb({ stock: 1, allowNegative: false }), input, { userId: 9 }), (e) => e.code === 'INSUFFICIENT_STOCK');
});
