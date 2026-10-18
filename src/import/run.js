// Database side of the historical import. planImport() decides WHAT to write; this file writes it, all in ONE transaction
// (pass a client from withTx). Nothing is half-imported: any failure rolls the whole file back.
import { createHash } from 'node:crypto';
import { readTable } from './parse.js';
import { planImport } from './plan.js';
import { normName } from './normalize.js';
import { voidSale } from '../sales/checkout.js';
import { AppError } from '../errors.js';

const c2n = (cents) => (cents / 100).toFixed(2);
const k2c = (v) => Math.round(Number(v) * 100);
const noon = `(($1::date + time '12:00') AT TIME ZONE 'Africa/Nairobi')`;     // $1 must be the date
const IMPORT_LOCK = 7001;

/** Everything planImport needs to know about the system as it is now. */
export async function loadRefData(db, { allowedBranchIds = null } = {}) {
  const q = async (sql) => (await db.query(sql)).rows;
  const today = (await q(`SELECT business_today()::text AS d`))[0].d;
  const services = (await q(`SELECT id, name, code, category_id, standard_price FROM services`))
    .map((r) => ({ id: Number(r.id), name: r.name, code: r.code, category_id: Number(r.category_id), price_cents: k2c(r.standard_price) }));
  const technicians = (await q(`SELECT id, display_name, branch_id FROM technicians`))
    .map((r) => ({ id: Number(r.id), display_name: r.display_name, branch_id: Number(r.branch_id) }));
  const branches = (await q(`SELECT id, code, name FROM branches WHERE is_active`)).filter((r) => !allowedBranchIds || allowedBranchIds.includes(Number(r.id))).map((r) => ({ id: Number(r.id), code: r.code, name: r.name }));
  const categories = (await q(`SELECT id, code FROM service_categories`)).map((r) => ({ id: Number(r.id), code: r.code }));
  const products = (await q(`SELECT p.id, p.sku, p.name,
      COALESCE(NULLIF((SELECT MAX(i.avg_unit_cost) FROM inventory i WHERE i.product_id = p.id), 0), p.purchase_cost) AS cost
      FROM products p WHERE p.is_active`)).map((r) => ({ id: Number(r.id), sku: r.sku, name: r.name, unit_cost_cents: Number(r.cost) * 100 }));
  const byPhone = new Map(), byName = new Map();
  for (const r of await q(`SELECT id, full_name, phone_normalized FROM customers WHERE deleted_at IS NULL`)) {
    const c = { id: Number(r.id), full_name: r.full_name, phone_normalized: r.phone_normalized };
    if (c.phone_normalized) byPhone.set(c.phone_normalized, c);
    const k = normName(c.full_name); (byName.get(k) || byName.set(k, []).get(k)).push(c);
  }
  const importKeys = new Set((await q(`SELECT import_key FROM transactions WHERE import_key IS NOT NULL AND status <> 'voided'`)).map((r) => r.import_key));
  const existingSales = new Set((await q(`SELECT DISTINCT customer_id || '|' || business_date::text AS k FROM transactions
      WHERE import_key IS NULL AND status <> 'voided'`)).map((r) => r.k));
  const rules = (await q(`SELECT id, scope, category_id, service_id, technician_id, calc_type, rate::float8 AS rate, fixed_amount::float8 AS fixed_amount,
      tiers, tier_base, to_char(effective_from,'YYYY-MM-DD') AS effective_from, to_char(effective_to,'YYYY-MM-DD') AS effective_to, is_active
      FROM commission_rules WHERE is_active`));
  return { today, services, technicians, branches, categories, products, byPhone, byName, importKeys, existingSales, rules };
}

const cap = (a, n) => ({ shown: a.slice(0, n), total: a.length });

function loadAndPlan(buffer, filename, ref, options) {
  const table = readTable(buffer, filename, { sheet: options.sheet });
  return planImport(table, ref, options);
}

/** Dry run: reads the file, reports what WOULD happen. Writes nothing. */
export async function previewImport(db, buffer, filename, options = {}) {
  const ref = await loadRefData(db, options);
  const p = loadAndPlan(buffer, filename, ref, options);
  if (p.fatal) return { ok: false, fatal: p.fatal };
  const canCommit = p.visits.length > 0 && (p.errors.length === 0 || options.skipInvalidRows === true);
  return {
    ok: true, canCommit, needsSkipInvalidRows: p.errors.length > 0 && !options.skipInvalidRows,
    summary: p.summary, columnMap: p.columnMap, unmatchedHeaders: p.unmatchedHeaders, unknown: p.unknown,
    errors: cap(p.errors, 200), warnings: cap(p.warnings, 200), overlaps: cap(p.overlapList, 50),
    newCustomers: cap(p.newCustomers.map((c) => ({ name: c.name, phone: c.phone || null })), 100),
    sample: p.visits.slice(0, 15).map((v) => ({ date: v.date, customer: v.customer.name, branch: v.branch.name, total: v.total / 100,
      lines: v.lines.map((l) => ({ service: l.svc.name, technician: l.tech.display_name, amount: l.amount / 100, method: l.method,
        materials: l.materials.map((m) => `${m.product.name} x${m.qty}`), commission: l.commission.amountCents / 100, commissionPaid: l.commission.paid })) })),
  };
}

/** Make `is_new_customer` true only on each customer's earliest non-cancelled visit. History imported later than live
 *  visits would otherwise leave the wrong "first visit" flagged. (The one place this frozen flag is deliberately recomputed.) */
async function refreshNewCustomerFlags(db, customerIds) {
  if (!customerIds.length) return;
  await db.query(
    `UPDATE visits v SET is_new_customer = (v.id = f.first_id)
       FROM (SELECT customer_id, (array_agg(id ORDER BY visit_date, id))[1] AS first_id
               FROM visits WHERE customer_id = ANY($1::bigint[]) AND status <> 'cancelled' GROUP BY customer_id) f
      WHERE v.customer_id = f.customer_id AND v.status <> 'cancelled' AND v.is_new_customer IS DISTINCT FROM (v.id = f.first_id)`, [customerIds]);
}

/** Write the import. `db` must be a transaction client (withTx). */
export async function commitImport(db, buffer, filename, options = {}, { userId = null } = {}) {
  await db.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK]);          // one import at a time: no racing duplicates
  const ref = await loadRefData(db, options);
  const p = loadAndPlan(buffer, filename, ref, options);
  if (p.fatal) throw new AppError(422, p.fatal.code, p.fatal.message, p.fatal);
  if (p.errors.length && options.skipInvalidRows !== true)
    throw new AppError(422, 'ROWS_INVALID', `${new Set(p.errors.map((e) => e.row)).size} row(s) have problems. Fix them, or import with "skip invalid rows".`, { errors: p.errors.slice(0, 50) });
  if (!p.visits.length) throw new AppError(422, 'NOTHING_TO_IMPORT', 'No new rows to import (all rows were invalid, duplicates, or already recorded).', { summary: p.summary });

  const sha = createHash('sha1').update(buffer).digest('hex');
  const first = p.visits[0].branch.id;
  const b = await db.query(
    `INSERT INTO import_batches (file_name, file_sha1, branch_id, options, summary, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [filename || 'upload', sha, options.branchId ?? first, JSON.stringify({ ...options, mapping: options.mapping || {} }), JSON.stringify(p.summary), userId]);
  const batchId = Number(b.rows[0].id);
  const created = { customers: [], services: [], technicians: [] };

  // --- reference data created on request
  const codes = new Set(ref.services.map((s) => s.code));
  for (const s of p.newServices) {
    let code = s.code, n = 2; while (codes.has(code)) code = `${s.code}_${n++}`; codes.add(code);
    const r = await db.query(`INSERT INTO services (code, name, category_id, standard_price) VALUES ($1,$2,$3,$4) RETURNING id`,
      [code, s.name, s.category_id ?? ref.categories.find((c) => c.code === 'OTHER')?.id ?? ref.categories[0].id, c2n(s.price_cents)]);
    s.id = Number(r.rows[0].id); created.services.push(s.id);
  }
  for (const t of p.newTechnicians) {
    const r = await db.query(`INSERT INTO technicians (branch_id, display_name) VALUES ($1,$2) RETURNING id`, [t.branch_id, t.display_name]);
    t.id = Number(r.rows[0].id); created.technicians.push(t.id);
  }
  // --- customers: new ones registered WITHOUT marketing consent; existing ones without a phone get the phone filled in
  for (const c of p.newCustomers) {
    const r = await db.query(
      `INSERT INTO customers (full_name, phone, whatsapp_number, marketing_consent, whatsapp_consent, sms_consent, registered_branch_id)
       VALUES ($1,$2,$2,false,false,false,$3) RETURNING id`, [c.name, c.phoneRaw || c.phone || null, p.visits.find((v) => v.customer === c).branch.id]);
    c.id = Number(r.rows[0].id); created.customers.push(c.id);
  }
  const filled = new Set();
  for (const v of p.visits) {
    const c = v.customer;
    if (c.fillPhone && !filled.has(c.id)) { filled.add(c.id);
      await db.query(`UPDATE customers SET phone = $2, whatsapp_number = COALESCE(whatsapp_number, $2) WHERE id = $1 AND phone_normalized IS NULL`, [c.id, c.phoneRaw || c.fillPhone]); }
  }

  // --- commissions dated before the cut-off are already paid in real life: record ONE payment per technician, tagged IMPORT
  const payByTech = new Map();
  const paidLines = p.visits.flatMap((v) => v.lines.filter((l) => l.commission.paid).map((l) => ({ l, v })));
  const byTech = new Map();
  paidLines.forEach(({ l, v }) => { const k = l.tech.id; const e = byTech.get(k) || { total: 0, from: v.date, to: v.date, branch: v.branch.id };
    e.total += l.commission.amountCents; if (v.date < e.from) e.from = v.date; if (v.date > e.to) e.to = v.date; byTech.set(k, e); });
  for (const [techId, e] of byTech) {
    if (e.total <= 0) continue;
    const r = await db.query(
      `INSERT INTO commission_payments (technician_id, branch_id, period_start, period_end, total_amount, method, reference, notes, paid_by)
       VALUES ($1,$2,$3,$4,$5,'other',$6,$7,$8) RETURNING id`,
      [techId, e.branch, e.from, e.to, c2n(e.total), `IMPORT batch ${batchId}`, 'Historical commission already paid before the system started. Recorded by data import.', userId]);
    payByTech.set(techId, Number(r.rows[0].id));
  }

  // --- the sales themselves, oldest first
  let nItems = 0, nTxn = 0;
  for (const v of p.visits) {
    const branchId = v.branch.id;
    const visit = await db.query(
      `INSERT INTO visits (branch_id, customer_id, visit_type, visit_date, checked_in_at, completed_at, status)
       VALUES ($2,$3,'walk_in',$1, ${noon}, ${noon}, 'completed') RETURNING id`, [v.date, branchId, v.customer.id]);
    const rc = await db.query('SELECT next_receipt_no($1, $2::date) AS r', [branchId, v.date]);
    const tx = await db.query(
      `INSERT INTO transactions (receipt_no, branch_id, visit_id, customer_id, subtotal, discount_total, total, occurred_at, business_date, created_by, import_batch_id, import_key)
       VALUES ($2,$3,$4,$5,$6,0,$6, ${noon}, $1::date, $7,$8,$9) RETURNING id`,
      [v.date, rc.rows[0].r, branchId, Number(visit.rows[0].id), v.customer.id, c2n(v.total), userId, batchId, v.importKey]);
    const txId = Number(tx.rows[0].id); nTxn++;

    let line = 0;
    for (const l of v.lines) {
      line++; nItems++;
      const ti = await db.query(
        `INSERT INTO transaction_items (transaction_id, line_no, item_type, service_id, technician_id, description, quantity, list_price, gross_amount, discount_amount, net_amount, material_cost)
         VALUES ($1,$2,'service',$3,$4,$5,1,$6,$6,0,$6,$7) RETURNING id`,
        [txId, line, l.svc.id, l.tech.id, l.svc.name, c2n(l.amount), c2n(l.materialCents)]);
      const itemId = Number(ti.rows[0].id);
      for (const m of l.materials)       // recorded for costing only: history does NOT move today's stock (no inventory_txn_id)
        await db.query(`INSERT INTO material_usage (transaction_item_id, product_id, branch_id, expected_qty, actual_qty, unit_cost, variance_flag)
                        VALUES ($1,$2,$3,0,$4,$5,false)`, [itemId, m.product.id, branchId, m.qty, (m.product.unit_cost_cents / 100).toFixed(4)]);
      const c = l.commission, payId = c.paid ? payByTech.get(l.tech.id) : null;
      await db.query(
        `INSERT INTO commission_calculations (transaction_item_id, transaction_id, technician_id, branch_id, rule_id, rule_snapshot, calc_type, service_price,
           material_cost, commissionable_amount, commission_rate, commission_amount, business_date, status, approved_by, approved_at, paid_at, commission_payment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, $15, ${payId ? 'now(), now()' : 'NULL, NULL'}, $16)`,
        [itemId, txId, l.tech.id, branchId, c.ruleId, JSON.stringify(c.snapshot), c.calcType, c2n(c.priceCents), c2n(c.materialCents), c2n(c.baseCents),
         c.rateBps == null ? null : (c.rateBps / 10000).toFixed(4), c2n(c.amountCents), v.date, payId ? 'paid' : 'pending', payId ? userId : null, payId]);
    }
    for (const [method, cents] of v.payments)
      await db.query(`INSERT INTO payments (transaction_id, method, amount, reference, received_at, created_by)
                      VALUES ($2,$3,$4,$6, ${noon}, $5)`, [v.date, txId, method, c2n(cents), userId, `IMPORT-${txId}-${method}`]);   // unique per payment: M-Pesa references must not repeat
  }

  const ids = [...new Set(p.visits.map((v) => v.customer.id))];
  await refreshNewCustomerFlags(db, ids);
  const summary = { ...p.summary, transactions: nTxn, items: nItems, customersCreated: created.customers.length };
  await db.query(`UPDATE import_batches SET summary = $2, created_refs = $3 WHERE id = $1`, [batchId, JSON.stringify(summary), JSON.stringify(created)]);
  return { batchId, summary, warnings: cap(p.warnings, 200), skippedRows: cap(p.errors, 200),
    note: 'Stock levels were NOT changed by this import. Materials were recorded for cost only.' };
}

/** Undo a whole import: voids every sale in the batch (history stays visible), retires what it created. */
export async function rollbackBatch(db, batchId, { userId = null, reason }) {
  if (!reason) throw new AppError(422, 'REASON_REQUIRED', 'A reason is required to roll back an import');
  const b = await db.query('SELECT id, status, created_refs FROM import_batches WHERE id = $1 FOR UPDATE', [batchId]);
  if (!b.rowCount) throw new AppError(404, 'NOT_FOUND', 'Import not found');
  if (b.rows[0].status === 'rolled_back') throw new AppError(409, 'ALREADY_ROLLED_BACK', 'This import was already rolled back');
  const refs = b.rows[0].created_refs || {};
  const t = await db.query(`SELECT id, visit_id, customer_id FROM transactions WHERE import_batch_id = $1 AND status <> 'voided'`, [batchId]);
  for (const r of t.rows) await voidSale(db, Number(r.id), { userId, reason: `Import #${batchId} rolled back: ${reason}` });
  const visitIds = t.rows.map((r) => Number(r.visit_id));
  if (visitIds.length) await db.query(`UPDATE visits SET status = 'cancelled' WHERE id = ANY($1::bigint[])`, [visitIds]);
  await refreshNewCustomerFlags(db, [...new Set(t.rows.map((r) => Number(r.customer_id)))]);

  const live = `EXISTS (SELECT 1 FROM transactions x WHERE x.status <> 'voided' AND x.customer_id = customers.id)`;
  let retired = { customers: 0, services: 0, technicians: 0 };
  if (refs.customers?.length) retired.customers = (await db.query(
    `UPDATE customers SET deleted_at = now() WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL AND NOT ${live}`, [refs.customers])).rowCount;
  if (refs.services?.length) retired.services = (await db.query(
    `UPDATE services SET is_active = false WHERE id = ANY($1::bigint[]) AND is_active
       AND NOT EXISTS (SELECT 1 FROM transaction_items ti JOIN transactions x ON x.id = ti.transaction_id WHERE ti.service_id = services.id AND x.status <> 'voided')`, [refs.services])).rowCount;
  if (refs.technicians?.length) retired.technicians = (await db.query(
    `UPDATE technicians SET is_active = false WHERE id = ANY($1::bigint[]) AND is_active
       AND NOT EXISTS (SELECT 1 FROM transaction_items ti JOIN transactions x ON x.id = ti.transaction_id WHERE ti.technician_id = technicians.id AND x.status <> 'voided')`, [refs.technicians])).rowCount;
  await db.query(`UPDATE import_batches SET status='rolled_back', rolled_back_at=now(), rolled_back_by=$2, rollback_reason=$3 WHERE id=$1`, [batchId, userId, reason]);
  return { batchId, status: 'rolled_back', salesVoided: t.rowCount, retired };
}

export async function listBatches(db) {
  const r = await db.query(`SELECT b.id, b.file_name, b.status, b.created_at, b.summary, u.full_name AS imported_by
       FROM import_batches b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 100`);
  return r.rows;
}
