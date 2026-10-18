// Branch 1 technicians. Loaded on start when LOAD_ROSTER=true into the FIRST branch. SAFE to repeat: names already on file are skipped.
export const ROSTER = {
  NAILS: ['Ahmed', 'Alice', 'Ashley', 'Celine', 'Elisha', 'Esther', 'Fehila', 'Hillary', 'Janet', 'Job', 'Julie', 'Melford', 'Mercy', 'Ngina', 'Njeri', 'Sharon', 'Stacy', 'Susan', 'Zilper'],
  HAIR: ['Maggie', 'Mary', 'Phyllis', 'Prudence', 'Vero', 'Wangari'],
};

export async function loadRoster(pool, log = console.log) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const b = await c.query('SELECT id, name FROM branches ORDER BY id LIMIT 1');
    if (!b.rowCount) throw new Error('No branch exists yet');
    let added = 0, total = 0;
    for (const [cat, names] of Object.entries(ROSTER)) for (const n of names) {
      total++;
      const r = await c.query(`INSERT INTO technicians (branch_id, display_name, specialty_category_id)
        SELECT $1, $2, sc.id FROM service_categories sc WHERE sc.code = $3
          AND NOT EXISTS (SELECT 1 FROM technicians WHERE branch_id = $1 AND lower(display_name) = lower($2))`, [b.rows[0].id, n, cat]);
      added += r.rowCount;
    }
    await c.query('COMMIT');
    log(`Roster: ${added} technician(s) added to "${b.rows[0].name}", ${total - added} already existed.`);
    return { added, total };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
