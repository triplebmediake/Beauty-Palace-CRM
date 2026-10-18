// Small, safe updates to an EXISTING database. Runs on every start; each statement is harmless to repeat.
// (A brand-new database gets the same columns from schema.sql.)
const STAFF_ABSENCES = `CREATE TABLE IF NOT EXISTS staff_absences (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, technician_id BIGINT NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  absent_on DATE NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('absent','sick','leave','late')), reason TEXT,
  recorded_by BIGINT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (technician_id, absent_on))`;
const ITEM_CREDITS = `CREATE OR REPLACE VIEW v_item_credits AS
SELECT ti.id AS item_id, ti.transaction_id, ti.service_id, ti.description, ti.technician_id,
       ti.net_amount - CASE WHEN ti.collab_technician_id IS NULL THEN 0 ELSE floor(ti.net_amount * 100 / 2) / 100 END AS amount,
       (ti.collab_technician_id IS NOT NULL) AS is_collab
  FROM transaction_items ti WHERE ti.item_type = 'service' AND ti.technician_id IS NOT NULL
UNION ALL
SELECT ti.id, ti.transaction_id, ti.service_id, ti.description, ti.collab_technician_id, floor(ti.net_amount * 100 / 2) / 100, true
  FROM transaction_items ti WHERE ti.item_type = 'service' AND ti.collab_technician_id IS NOT NULL`;
export const MIGRATIONS = [
  // Receipt numbers start with the branch code: CNS-2026-000001 (branch 1) and BPK-2026-000001 (branch 2). Receipts already issued keep their old numbers.
  ['branch 1 receipt prefix CNS', `UPDATE branches SET code = 'CNS', updated_at = now() WHERE id = (SELECT MIN(id) FROM branches) AND code <> 'CNS' AND NOT EXISTS (SELECT 1 FROM branches WHERE code = 'CNS')`],
  ['branch 2 receipt prefix BPK', `UPDATE branches SET code = 'BPK', updated_at = now() WHERE lower(name) = 'beauty palace kenya' AND code <> 'BPK' AND NOT EXISTS (SELECT 1 FROM branches WHERE code = 'BPK')`],
  ['business settings permission', `INSERT INTO permissions (code, description) VALUES ('settings.business', 'Change salon name, logo, contact details and hours') ON CONFLICT (code) DO NOTHING`],
  ['business settings for owners', `INSERT INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p WHERE r.code IN ('super_admin', 'owner') AND p.code = 'settings.business' ON CONFLICT DO NOTHING`],
  ['staff profile fields', `ALTER TABLE technicians ADD COLUMN IF NOT EXISTS email TEXT, ADD COLUMN IF NOT EXISTS national_id TEXT, ADD COLUMN IF NOT EXISTS id_photo TEXT`],
  ['staff absences', STAFF_ABSENCES],
  ['collabo: second hairdresser column', `ALTER TABLE transaction_items ADD COLUMN IF NOT EXISTS collab_technician_id BIGINT REFERENCES technicians(id)`],
  ['collabo: one commission row per hairdresser', `DROP INDEX IF EXISTS ux_cc_one_original_per_item`],
  ['collabo: one commission row per hairdresser (new rule)', `CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_one_original_per_item_tech ON commission_calculations (transaction_item_id, technician_id) WHERE reverses_id IS NULL`],
  ['collabo: credits view', ITEM_CREDITS],
  ['sale notes', `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS notes TEXT`],
];

export async function migrate(pool, log = console.log) {
  const exists = await pool.query(`SELECT to_regclass('public.transactions') AS t`);
  if (!exists.rows[0]?.t) return { ran: 0 };                 // empty database: setup will create everything
  for (const [name, sql] of MIGRATIONS) {
    try { await pool.query(sql); } catch (e) { throw new Error(`Migration "${name}" failed: ${e.message}`); }
  }
  log(`Migrations checked (${MIGRATIONS.length}).`);
  return { ran: MIGRATIONS.length };
}
