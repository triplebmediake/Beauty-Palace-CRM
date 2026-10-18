// Standard price list for Cute Nails & Salons Kenya (from the salon's price posters).
// Loaded on start when LOAD_CATALOGUE=true. SAFE to repeat: services that already exist (same code) are left alone,
// so prices the Owner has edited later are never overwritten.
// [code, name, category, price KES, duration minutes (a starting guess - editable later)]
export const CATALOGUE = [
  // Nails
  ['NAIL-PEDICURE', 'Pedicure', 'NAILS', 400, 45], ['NAIL-GEL-POLISH', 'Gel Polish', 'NAILS', 400, 45],
  ['NAIL-TIPS-GEL', 'Tips + Gel', 'NAILS', 500, 60], ['NAIL-FRENCH-TIPS', 'French tips', 'NAILS', 800, 75],
  ['NAIL-BUILDER-GEL', 'Builder gel', 'NAILS', 800, 75], ['NAIL-OMBRE', 'Ombre', 'NAILS', 1000, 75],
  ['NAIL-ACRYLICS', 'Acrylics', 'NAILS', 1000, 90], ['NAIL-GUM-GEL', 'Gum Gel', 'NAILS', 1500, 90],
  ['NAIL-OVERLAYS', 'Overlays', 'NAILS', 1000, 75], ['NAIL-SCULPTING', 'Sculpting', 'NAILS', 1800, 120],
  // Waxing
  ['WAX-FULL-BRAZILIAN', 'Full Brazilian', 'WAXING', 800, 30], ['WAX-UNDERARMS', 'Underarms', 'WAXING', 400, 15],
  ['WAX-BRAZILIAN-UNDERARM', 'Full Brazilian + underarm', 'WAXING', 1100, 40], ['WAX-MANZILIAN', 'Manzilian', 'WAXING', 1500, 45],
  ['WAX-MANZILIAN-UNDERARM', 'Manzilian + underarm', 'WAXING', 2000, 50], ['WAX-FULL-BIKINI', 'Full Bikini', 'WAXING', 1000, 30],
  ['WAX-BIKINI-BRAZ-ARMPITS', 'Full bikini + Brazilian + armpits', 'WAXING', 2000, 60],
  ['WAX-HALF-BIKINI-BRAZ', 'Half bikini + Brazilian', 'WAXING', 1300, 45], ['WAX-FULL-BODY', 'Full body', 'WAXING', 4900, 150],
  ['WAX-FULL-LEGS', 'Full legs from thighs', 'WAXING', 1500, 45], ['WAX-KNEES-TO-TOES', 'Knees to toes', 'WAXING', 1000, 30],
  ['WAX-FULL-HANDS', 'Full hands', 'WAXING', 1000, 30], ['WAX-HALF-HANDS', 'Half hands', 'WAXING', 500, 20],
  // Hair: dreadlocs
  ['HAIR-DREAD-RETOUCH', 'Dread Retouch', 'HAIR', 700, 90], ['HAIR-DREAD-RETOUCH-DYE', 'Dread Retouch + Dye (Black)', 'HAIR', 1500, 120],
  ['HAIR-CROCHET-RETOUCH', 'Crochet retouch', 'HAIR', 1200, 120], ['HAIR-UNDO-ART-LOCS', 'Undoing artificial locs', 'HAIR', 2000, 180],
  ['HAIR-ART-LOCS-SHOULDER', 'Artificial locs - Shoulder length', 'HAIR', 4000, 300],
  ['HAIR-ART-LOCS-MIDBACK', 'Artificial locs - Mid-back length', 'HAIR', 4500, 330],
  ['HAIR-ART-LOCS-WAIST', 'Artificial locs - Waist length', 'HAIR', 5500, 360],
  // Hair: braids
  ['HAIR-BOX-BRAIDS', 'Box Braids (up to 5 braids)', 'HAIR', 1400, 180], ['HAIR-KNOTLESS-BRAIDS', 'Knotless Braids (up to 5 braids)', 'HAIR', 1400, 180],
  ['HAIR-CORNROWS', 'Corn Rows / Ghanaian', 'HAIR', 1400, 120], ['HAIR-STITCH-LINES', 'Stitch lines', 'HAIR', 1700, 150],
  ['HAIR-GYPSY-LOCS', 'Gypsy locs (incl. braids)', 'HAIR', 3500, 240],
  // Massage
  ['MSG-SWEDISH', 'Swedish massage', 'MASSAGE', 2000, 60], ['MSG-HOT-STONE', 'Hot stone massage', 'MASSAGE', 3000, 75],
  ['MSG-DEEP-TISSUE', 'Deep tissue massage', 'MASSAGE', 3500, 60], ['MSG-AROMA', 'Aroma therapy', 'MASSAGE', 3000, 60],
  ['MSG-BODY-SCRUB', 'Body scrub', 'MASSAGE', 1500, 45],
  // Facials, lashes, makeup, wigs, piercing
  ['FACIAL-STANDARD', 'Facial', 'FACIAL', 1000, 45],
  ['LASH-CLASSIC', 'Classic lashes', 'LASHES', 1000, 90], ['LASH-CAT-EYE', 'Cat-eye lashes', 'LASHES', 1300, 90],
  ['MAKEUP-STANDARD', 'Makeup', 'MAKEUP', 1000, 45],
  ['WIG-GLUELESS', 'Glueless wig installation', 'HAIR', 800, 45], ['WIG-GLUED', 'Glued wig installation', 'HAIR', 1000, 60], ['WIG-LAUNDRY', 'Wig laundry', 'HAIR', 1000, 60],
  ['PIERCE-MEDUSA', 'Medusa piercing', 'PIERCING', 700, 15], ['PIERCE-TONGUE', 'Tongue piercing', 'PIERCING', 700, 15],
  ['PIERCE-SMILEY', 'Smiley piercing', 'PIERCING', 600, 15], ['PIERCE-EAR', 'Ear piercing', 'PIERCING', 500, 15],
  ['PIERCE-NOSE', 'Nose piercing', 'PIERCING', 600, 15], ['PIERCE-NAVEL', 'Navel piercing', 'PIERCING', 700, 15],
];

export async function loadCatalogue(pool, log = console.log) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let added = 0;
    for (const [code, name, cat, price, mins] of CATALOGUE) {
      const r = await c.query(
        `INSERT INTO services (code, name, category_id, standard_price, duration_minutes)
         SELECT $1, $2, sc.id, $3, $4 FROM service_categories sc WHERE sc.code = $5
         ON CONFLICT (code) DO NOTHING RETURNING id`, [code, name, price, mins, cat]);
      added += r.rowCount;
    }
    await c.query('COMMIT');
    log(`Catalogue: ${added} new service(s) added, ${CATALOGUE.length - added} already existed.`);
    return { added, total: CATALOGUE.length };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
