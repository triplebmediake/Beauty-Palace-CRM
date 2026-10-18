import { planSale } from './plan.js';
import { AppError } from '../errors.js';

const c2n = (cents) => (cents / 100).toFixed(2);
const k2c = (v) => Math.round(Number(v) * 100);

/** Load everything planSale needs, using the transaction client (rows are consistent with this sale). */
async function loadContext(db, { branchId, businessDate, lines }) {
  const svc = await db.query(
    `SELECT s.id, s.name, s.category_id, sc.code AS category_code, COALESCE(sbp.price, s.standard_price) AS price
       FROM services s JOIN service_categories sc ON sc.id = s.category_id
       LEFT JOIN service_branch_prices sbp ON sbp.service_id = s.id AND sbp.branch_id = $1
      WHERE s.is_active AND COALESCE(sbp.is_available, true)`, [branchId]);
  const services = new Map(svc.rows.map((r) => [Number(r.id), { id: Number(r.id), name: r.name,
    category_id: Number(r.category_id), category_code: r.category_code, price_cents: k2c(r.price) }]));

  const prod = await db.query(
    `SELECT p.id, p.name, p.selling_price,
            COALESCE(NULLIF(i.avg_unit_cost, 0), p.purchase_cost) AS unit_cost
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id AND i.branch_id = $1
      WHERE p.is_active`, [branchId]);
  const products = new Map(prod.rows.map((r) => [Number(r.id), { id: Number(r.id), name: r.name,
    unit_cost_cents: Number(r.unit_cost) * 100, selling_price_cents: k2c(r.selling_price) }]));

  const sm = await db.query('SELECT service_id, product_id, default_qty FROM service_materials');
  const serviceMaterials = new Map();
  sm.rows.forEach((r) => {
    const k = Number(r.service_id);
    (serviceMaterials.get(k) || serviceMaterials.set(k, []).get(k)).push(
      { product_id: Number(r.product_id), default_qty: Number(r.default_qty) });
  });

  const pk = await db.query(
    `SELECT p.id, p.price, p.commission_basis, pi.service_id, pi.quantity, pi.individual_value
       FROM packages p JOIN package_items pi ON pi.package_id = p.id WHERE p.is_active`);
  const packages = new Map();
  pk.rows.forEach((r) => {
    const id = Number(r.id);
    if (!packages.has(id)) packages.set(id, { id, price_cents: k2c(r.price), commission_basis: r.commission_basis, items: [] });
    packages.get(id).items.push({ service_id: Number(r.service_id), quantity: r.quantity,
      individual_value_cents: r.individual_value == null ? null : k2c(r.individual_value) });
  });

  const rr = await db.query(
    `SELECT id, scope, category_id, service_id, technician_id, calc_type, rate::float8 AS rate,
            fixed_amount::float8 AS fixed_amount, tiers, tier_base,
            to_char(effective_from,'YYYY-MM-DD') AS effective_from,
            to_char(effective_to,'YYYY-MM-DD') AS effective_to, is_active
       FROM commission_rules WHERE is_active`);

  const st = await db.query(`SELECT key, value FROM app_settings WHERE branch_id IS NULL AND key LIKE 'sales.%'`);
  const settings = {};
  st.rows.forEach((r) => {
    const v = r.value;
    if (r.key === 'sales.commission_basis') settings.commissionBasis = v;
    if (r.key === 'sales.discount_approval_pct') settings.discountApprovalPct = Number(v);
    if (r.key === 'sales.material_variance_pct') settings.varianceFlagPct = Number(v);
  });

  const techIds = [...new Set(lines.flatMap((l) => [l.technicianId, l.collabTechnicianId, ...Object.values(l.technicianByService || {})]).filter(Boolean).map(Number))];
  const tr = await db.query(
    `SELECT t.id, t.display_name, t.is_active,
            COALESCE(array_agg(ts.service_id) FILTER (WHERE ts.service_id IS NOT NULL), '{}') AS elig
       FROM technicians t LEFT JOIN technician_services ts ON ts.technician_id = t.id
      WHERE t.id = ANY($1::bigint[]) GROUP BY t.id`, [techIds]);
  const technicians = new Map(tr.rows.map((r) => [Number(r.id), { display_name: r.display_name, is_active: r.is_active,
    eligible_service_ids: r.elig.map(Number) }]));

  // period-to-date commissionable base per technician (Saturday-Friday week), for tiered rules
  const pb = await db.query(
    `SELECT technician_id, COALESCE(SUM(commissionable_amount),0) AS base FROM commission_calculations
      WHERE technician_id = ANY($1::bigint[]) AND business_week_start(business_date) = business_week_start($2::date)
      GROUP BY technician_id`, [techIds, businessDate]);
  const priorBase = new Map(pb.rows.map((r) => [Number(r.technician_id), k2c(r.base)]));

  return { businessDate, services, products, serviceMaterials, packages, rules: rr.rows, settings, technicians, priorBase };
}

async function resolveCustomer(db, input, branchId) {
  if (input.customerId) {
    const r = await db.query('SELECT id FROM customers WHERE id = $1 AND deleted_at IS NULL', [input.customerId]);
    if (!r.rowCount) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
    return { id: Number(r.rows[0].id), created: false };
  }
  const n = input.newCustomer;
  if (!n?.fullName) throw new AppError(422, 'CUSTOMER_REQUIRED', 'Select or register a customer');
  if (n.phone) {                                   // never create a duplicate for the same phone number
    const d = await db.query('SELECT id FROM customers WHERE phone_normalized = normalize_ke_phone($1) AND deleted_at IS NULL', [n.phone]);
    if (d.rowCount) return { id: Number(d.rows[0].id), created: false, matchedByPhone: true };
  }
  let birthday = null;
  if (n.birthday != null && String(n.birthday).trim() !== '') {
    const t = String(n.birthday).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t)) || t < '1900-01-01' || t > new Date().toISOString().slice(0, 10)) throw new AppError(422, 'BAD_BIRTHDAY', 'Birthday must be a valid date in the past');
    birthday = t;
  }
  const r = await db.query(
    `INSERT INTO customers (full_name, phone, whatsapp_number, marketing_consent, whatsapp_consent, sms_consent, registered_branch_id, birthday)
     VALUES ($1,$2,$3,$4,$4,$4,$5,$6::date) RETURNING id`,
    [n.fullName, n.phone ?? null, n.whatsappNumber ?? n.phone ?? null, !!n.consent, branchId, birthday]);
  return { id: Number(r.rows[0].id), created: true };
}

/** Deduct stock under a row lock. Throws if stock would go negative (unless allowNegativeStock). */
export async function moveStock(db, { productId, branchId, qty, type, unitCost, reason, refType, refId, userId, allowNegative }) {
  await db.query('INSERT INTO inventory (product_id, branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [productId, branchId]);
  const cur = await db.query('SELECT qty_on_hand FROM inventory WHERE product_id=$1 AND branch_id=$2 FOR UPDATE', [productId, branchId]);
  if (qty < 0 && !allowNegative && Number(cur.rows[0].qty_on_hand) + qty < 0)
    throw new AppError(409, 'INSUFFICIENT_STOCK', `Not enough stock for product ${productId} (have ${cur.rows[0].qty_on_hand}, need ${-qty})`);
  const r = await db.query(
    `INSERT INTO inventory_transactions (product_id, branch_id, txn_type, qty_change, unit_cost, reference_type, reference_id, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [productId, branchId, type, qty, unitCost, refType, refId, reason ?? null, userId]);
  const onHand = Number(cur.rows[0].qty_on_hand) + qty;
  return { id: Number(r.rows[0].id), onHand, negative: qty < 0 && onHand < 0 };
}

/** Raise (once) an open alert for a product that has gone below zero, so management can fix the stock count. */
async function flagNegativeStock(db, { productId, branchId, onHand }) {
  await db.query(`INSERT INTO alert_rules (code) VALUES ('negative_stock') ON CONFLICT DO NOTHING`);
  await db.query(
    `INSERT INTO alerts (rule_code, branch_id, entity_type, entity_id, message)
     SELECT 'negative_stock', $1, 'product', $2, $3
      WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE rule_code='negative_stock' AND entity_type='product'
                         AND entity_id=$2 AND branch_id=$1 AND resolved_at IS NULL)`,
    [branchId, productId, `Stock is below zero (${onHand}). Record the missing purchase or correct the count.`]);
}

async function allowNegativeSetting(db) {
  const r = await db.query(`SELECT value FROM app_settings WHERE branch_id IS NULL AND key = 'inventory.allow_negative_stock'`);
  return r.rowCount ? r.rows[0].value === true || r.rows[0].value === 'true' : true;   // default: allow, but flag
}

/**
 * Record a complete sale in the CALLER'S transaction (use withTx):
 *   customer -> visit -> transaction -> items -> materials + stock -> frozen commissions -> discounts -> payments
 */
export async function checkout(db, input, { userId = null, allowNegativeStock } = {}) {
  const allowNegative = allowNegativeStock ?? await allowNegativeSetting(db);
  const stockWarnings = [];
  const branchId = Number(input.branchId);
  const bd = await db.query('SELECT business_today()::text AS d');
  const businessDate = input.businessDate || bd.rows[0].d;

  const cust = await resolveCustomer(db, input, branchId);
  const ctx = await loadContext(db, { branchId, businessDate, lines: input.lines || [] });
  const plan = planSale(input, ctx);

  const visit = await db.query(
    `INSERT INTO visits (branch_id, customer_id, appointment_id, visit_type, visit_date, status, completed_at, created_by)
     VALUES ($1,$2,$3,$4,$5,'completed',now(),$6) RETURNING id, is_new_customer`,
    [branchId, cust.id, input.appointmentId ?? null, input.appointmentId ? 'appointment' : 'walk_in', businessDate, userId]);
  const visitId = Number(visit.rows[0].id);

  const rc = await db.query('SELECT next_receipt_no($1, $2::date) AS r', [branchId, businessDate]);
  const t = plan.totals;
  const tx = await db.query(
    `INSERT INTO transactions (receipt_no, branch_id, visit_id, customer_id, subtotal, discount_total, total, business_date, created_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [rc.rows[0].r, branchId, visitId, cust.id, c2n(t.subtotal), c2n(t.discount), c2n(t.total), businessDate, userId,
     typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim().slice(0, 500) : null]);
  const txId = Number(tx.rows[0].id);

  let line = 0;
  for (const it of plan.items) {
    line += 1;
    const ti = await db.query(
      `INSERT INTO transaction_items (transaction_id, line_no, item_type, service_id, product_id, package_id, package_group,
         technician_id, description, quantity, list_price, gross_amount, discount_amount, net_amount, material_cost, collab_technician_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [txId, line, it.item_type, it.service_id ?? null, it.product_id ?? null, it.package_id ?? null, it.package_group ?? null,
       it.technician_id, it.description, it.quantity, c2n(it.list_cents), c2n(it.gross_cents), c2n(it.discount_cents),
       c2n(it.net_cents), c2n(it.material_cents), it.collab_technician_id ?? null]);
    const itemId = Number(ti.rows[0].id);
    it.id = itemId;

    for (const m of it.materials) {                                  // actual usage -> stock ledger + material_usage
      const mv = await moveStock(db, { productId: m.product_id, branchId, qty: -m.actual_qty, type: 'service_consumption',
        unitCost: m.unit_cost_cents / 100, refType: 'transaction_item', refId: itemId, userId, allowNegative });
      const invId = mv.id;
      if (mv.negative) stockWarnings.push({ productId: m.product_id, name: m.name, onHand: mv.onHand });
      await db.query(
        `INSERT INTO material_usage (transaction_item_id, product_id, branch_id, expected_qty, actual_qty, unit_cost, variance_flag, inventory_txn_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [itemId, m.product_id, branchId, m.expected_qty, m.actual_qty, (m.unit_cost_cents / 100).toFixed(4), m.variance_flag, invId]);
    }
    if (it.item_type === 'product') {
      const mv = await moveStock(db, { productId: it.product_id, branchId, qty: -it.quantity, type: 'sale', unitCost: null,
        refType: 'transaction_item', refId: itemId, userId, allowNegative });
      if (mv.negative) stockWarnings.push({ productId: it.product_id, name: it.description, onHand: mv.onHand });
    }

    for (const c of it.commission ? (it.commission.parts ?? [{ ...it.commission, technician_id: it.technician_id }]) : []) {      // two parts when two hairdressers shared the service
      await db.query(
        `INSERT INTO commission_calculations (transaction_item_id, transaction_id, technician_id, branch_id, rule_id, rule_snapshot,
           calc_type, service_price, material_cost, commissionable_amount, commission_rate, commission_amount, business_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [itemId, txId, c.technician_id, branchId, c.ruleId, JSON.stringify(c.snapshot), c.calcType, c2n(c.priceCents),
         c2n(c.materialCents), c2n(c.baseCents), c.rateBps == null ? null : (c.rateBps / 10000).toFixed(4), c2n(c.amountCents), businessDate]);
    }
  }

  for (const w of stockWarnings) await flagNegativeStock(db, { productId: w.productId, branchId, onHand: w.onHand });

  for (const d of plan.discounts)
    await db.query(
      `INSERT INTO transaction_discounts (transaction_id, definition_id, discount_type, value, is_percent, amount, reason, applied_by, approved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [txId, d.definition_id, d.discount_type, d.value, d.is_percent, c2n(d.amount_cents), d.reason, userId, input.discountApprovedBy ?? null]);

  for (const p of plan.payments)
    await db.query('INSERT INTO payments (transaction_id, method, amount, reference, created_by) VALUES ($1,$2,$3,$4,$5)',
      [txId, p.method, c2n(p.amount_cents), p.reference, userId]);

  return { transactionId: txId, visitId, receiptNo: rc.rows[0].r, customerId: cust.id, customerCreated: cust.created,
    isNewCustomer: visit.rows[0].is_new_customer, stockWarnings, totals: t, commissionTotal: plan.commissionTotal,
    materialTotal: plan.materialTotal, items: plan.items.map((i) => ({ id: i.id, description: i.description,
      technicianId: i.technician_id, net: i.net_cents, materials: i.material_cents, commission: i.commission?.amountCents ?? null })) };
}

/** Void a sale: status + reason, reversing commission rows, stock returned, refunds recorded. Nothing is deleted. */
export async function voidSale(db, transactionId, { userId = null, reason }) {
  if (!reason) throw new AppError(422, 'REASON_REQUIRED', 'A reason is required to void a sale');
  const t = await db.query('SELECT id, branch_id, status, amount_paid, import_batch_id FROM transactions WHERE id=$1 FOR UPDATE', [transactionId]);
  if (!t.rowCount) throw new AppError(404, 'NOT_FOUND', 'Sale not found');
  if (t.rows[0].status === 'voided') throw new AppError(409, 'ALREADY_VOIDED', 'Sale is already voided');
  const branchId = Number(t.rows[0].branch_id);
  const imported = t.rows[0].import_batch_id != null;

  // Imported history: the reversal carries the original's paid/approved state so it nets to zero instead of becoming a new debt
  // against the technician's next pay. Live sales: the reversal is pending, i.e. recovered from future pay.
  await db.query(
    `INSERT INTO commission_calculations (transaction_item_id, transaction_id, technician_id, branch_id, rule_id, rule_snapshot, calc_type,
       service_price, material_cost, commissionable_amount, commission_rate, commission_amount, business_date, reverses_id,
       status, approved_by, approved_at, paid_at, commission_payment_id)
     SELECT transaction_item_id, transaction_id, technician_id, branch_id, rule_id, rule_snapshot, calc_type,
            service_price, material_cost, commissionable_amount, commission_rate, -commission_amount, business_date, id,
            CASE WHEN $2 THEN status ELSE 'pending' END, CASE WHEN $2 THEN approved_by END, CASE WHEN $2 THEN approved_at END,
            CASE WHEN $2 THEN paid_at END, CASE WHEN $2 THEN commission_payment_id END
       FROM commission_calculations WHERE transaction_id = $1 AND reverses_id IS NULL`, [transactionId, imported]);

  const mu = await db.query(
    `SELECT mu.product_id, mu.actual_qty, mu.unit_cost, mu.transaction_item_id FROM material_usage mu
       JOIN transaction_items ti ON ti.id = mu.transaction_item_id
      WHERE ti.transaction_id = $1 AND mu.inventory_txn_id IS NOT NULL`, [transactionId]);   // imported history never touched stock
  for (const m of mu.rows)
    await moveStock(db, { productId: Number(m.product_id), branchId, qty: Number(m.actual_qty), type: 'return', unitCost: Number(m.unit_cost),
      reason: 'Void: ' + reason, refType: 'transaction_item', refId: Number(m.transaction_item_id), userId });
  const pr = await db.query(`SELECT product_id, quantity, id FROM transaction_items WHERE transaction_id=$1 AND item_type='product'`, [transactionId]);
  for (const p of pr.rows)
    await moveStock(db, { productId: Number(p.product_id), branchId, qty: Number(p.quantity), type: 'return', unitCost: null,
      reason: 'Void: ' + reason, refType: 'transaction_item', refId: Number(p.id), userId });

  const paid = imported ? { rows: [] } : await db.query(`SELECT method, SUM(amount) AS amt FROM payments WHERE transaction_id=$1 GROUP BY method HAVING SUM(amount) > 0`, [transactionId]);
  for (const p of paid.rows)
    await db.query('INSERT INTO payments (transaction_id, method, amount, reference, created_by) VALUES ($1,$2,$3,$4,$5)',
      [transactionId, p.method, -Number(p.amt), 'REFUND: ' + reason, userId]);

  await db.query(`UPDATE transactions SET status='voided', voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1`, [transactionId, userId, reason]);
  return { transactionId, status: 'voided' };
}
