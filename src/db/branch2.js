// Branch 2: Beauty Palace Kenya. Loaded on start when LOAD_BRANCH2=true. SAFE to repeat: the branch and technicians that
// already exist are left alone. Owners and Super Admins are given access to the new branch.
export const BRANCH2 = {
  code: 'BPK', name: 'Beauty Palace Kenya',         // the code prefixes receipt numbers (BPK-2026-000001)
  roster: {
    NAILS: ['Benadate', 'Courtney', 'Diane', 'Dickson', 'Evon', 'Febu', 'Pascal', 'Stanoh', 'Teddy'],
    HAIR: ['Cate W', 'Gertrude', 'Hellen', 'Ruth'],
  },
};

export async function loadBranch2(pool, log = console.log, spec = BRANCH2) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO branches (code, name) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM branches WHERE code = $1 OR lower(name) = lower($2))`, [spec.code, spec.name]);
    const b = await c.query(`SELECT id FROM branches WHERE code = $1 OR lower(name) = lower($2) ORDER BY id LIMIT 1`, [spec.code, spec.name]);
    const id = b.rows[0].id;
    await c.query(`UPDATE branches SET code = $2, updated_at = now() WHERE id = $1 AND code <> $2 AND NOT EXISTS (SELECT 1 FROM branches WHERE code = $2)`, [id, spec.code]);
    let added = 0, total = 0;
    for (const [cat, names] of Object.entries(spec.roster)) for (const n of names) {
      total++;
      const r = await c.query(`INSERT INTO technicians (branch_id, display_name, specialty_category_id)
        SELECT $1, $2, sc.id FROM service_categories sc WHERE sc.code = $3
          AND NOT EXISTS (SELECT 1 FROM technicians WHERE branch_id = $1 AND lower(display_name) = lower($2))`, [id, n, cat]);
      added += r.rowCount;
    }
    const u = await c.query(`INSERT INTO user_branches (user_id, branch_id) SELECT us.id, $1 FROM users us JOIN roles r ON r.id = us.role_id WHERE r.code IN ('super_admin', 'owner') ON CONFLICT DO NOTHING`, [id]);
    await c.query('COMMIT');
    log(`Branch 2 "${spec.name}": ${added} technician(s) added, ${total - added} already existed; ${u.rowCount} owner/admin login(s) given access.`);
    return { branchId: Number(id), added, total };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
