// Growth screens: "customers due" follow-ups, loyalty points, and marketing campaigns.
// Messages are NOT sent by the server: each campaign becomes a list of personalised messages, and staff send them
// with one tap (WhatsApp / SMS app) and mark them sent. That keeps it free, simple, and consent-only.
import { AppError } from '../errors.js';
import { loadBusiness } from './settings.js';

export const SALON = 'Cute Nails & Salons Kenya';
export const SEGMENT_STATUSES = ['new', 'active', 'returning', 'due', 'at_risk', 'lapsed', 'win_back', 'inactive', 'vip'];
const DEFAULT_RULES = { spendPerPoint: 100, pointsPerVisit: 0, birthdayBonus: 0, pointValue: 1, minRedeem: 50 };

export const renderMessage = (tpl, name, salon = SALON) => String(tpl).replaceAll('{name}', String(name || '').trim().split(/\s+/)[0] || 'there').replaceAll('{salon}', salon);

/** Reads loyalty settings (rules table + one setting row) into one plain object. */
export async function loadRules(c) {
  const r = await c.query(`SELECT rule_type, params FROM loyalty_rules WHERE is_active ORDER BY id`);
  const s = await c.query(`SELECT key, value FROM app_settings WHERE branch_id IS NULL AND key IN ('loyalty.point_value','loyalty.min_redeem')`);
  const out = { ...DEFAULT_RULES, spendPerPoint: 0 };                          // until the owner sets a rule, nobody earns points
  for (const x of r.rows) {
    const p = x.params || {};
    if (x.rule_type === 'points_per_spend') out.spendPerPoint = Number(p.spend_per_point) || 0;
    if (x.rule_type === 'points_per_visit') out.pointsPerVisit = Number(p.points) || 0;
    if (x.rule_type === 'birthday_bonus') out.birthdayBonus = Number(p.points) || 0;
  }
  for (const x of s.rows) { const n = Number(x.value); if (x.key === 'loyalty.point_value' && n > 0) out.pointValue = n; if (x.key === 'loyalty.min_redeem' && n >= 0) out.minRedeem = n; }
  return out;
}

async function accountFor(c, customerId, lock = false) {
  await c.query(`INSERT INTO loyalty_accounts (customer_id) VALUES ($1) ON CONFLICT (customer_id) DO NOTHING`, [customerId]);
  const a = await c.query(`SELECT id, points_balance, lifetime_points FROM loyalty_accounts WHERE customer_id = $1${lock ? ' FOR UPDATE' : ''}`, [customerId]);
  return a.rows[0];
}
async function addPoints(c, acct, points, reason, transactionId = null) {
  await c.query(`INSERT INTO loyalty_transactions (account_id, points, reason, transaction_id) VALUES ($1, $2, $3, $4)`, [acct.id, points, reason, transactionId]);
  await c.query(`UPDATE loyalty_accounts SET points_balance = points_balance + $2, lifetime_points = lifetime_points + $3 WHERE id = $1`, [acct.id, points, Math.max(points, 0)]);
}

/** Called right after a sale is rung up (inside the sale's transaction). Never lets a loyalty problem block a sale. */
export async function awardForSale(c, transactionId) {
  try {
    await c.query('SAVEPOINT loyalty');
    const t = await c.query(`SELECT t.customer_id, t.total, t.business_date::text AS d, c.birthday::text AS birthday
                               FROM transactions t JOIN customers c ON c.id = t.customer_id WHERE t.id = $1 AND t.customer_id IS NOT NULL`, [transactionId]);
    if (t.rowCount) {
      const row = t.rows[0], rules = await loadRules(c);
      let pts = rules.spendPerPoint > 0 ? Math.floor(Number(row.total) / rules.spendPerPoint) : 0;
      const parts = pts ? [`${pts} for spend`] : [];
      if (rules.pointsPerVisit > 0) { pts += rules.pointsPerVisit; parts.push(`${rules.pointsPerVisit} for the visit`); }
      const acct = pts > 0 || rules.birthdayBonus > 0 ? await accountFor(c, Number(row.customer_id), true) : null;
      if (pts > 0) await addPoints(c, acct, pts, `Sale: ${parts.join(' + ')}`, transactionId);
      if (rules.birthdayBonus > 0 && row.birthday && row.birthday.slice(5) === row.d.slice(5)) {
        const year = row.d.slice(0, 4), have = await c.query(`SELECT 1 FROM loyalty_transactions WHERE account_id = $1 AND reason = $2`, [acct.id, `Birthday bonus ${year}`]);
        if (!have.rowCount) await addPoints(c, acct, rules.birthdayBonus, `Birthday bonus ${year}`, transactionId);
      }
    }
    await c.query('RELEASE SAVEPOINT loyalty');
  } catch (e) { await c.query('ROLLBACK TO SAVEPOINT loyalty').catch(() => {}); console.error('Loyalty award skipped:', e.message); }
}

/** When a sale is voided, take back the points it earned. */
export async function reverseForSale(c, transactionId) {
  try {
    await c.query('SAVEPOINT loyalty_rev');
    const r = await c.query(`SELECT lt.account_id, SUM(lt.points) AS pts FROM loyalty_transactions lt WHERE lt.transaction_id = $1 GROUP BY lt.account_id`, [transactionId]);
    for (const x of r.rows) {
      const pts = Number(x.pts);
      if (pts !== 0) { await c.query(`INSERT INTO loyalty_transactions (account_id, points, reason, transaction_id) VALUES ($1, $2, 'Sale voided: points taken back', $3)`, [x.account_id, -pts, transactionId]);
        await c.query(`UPDATE loyalty_accounts SET points_balance = points_balance - $2, lifetime_points = GREATEST(0, lifetime_points - $2) WHERE id = $1`, [x.account_id, pts]); }
    }
    await c.query('RELEASE SAVEPOINT loyalty_rev');
  } catch (e) { await c.query('ROLLBACK TO SAVEPOINT loyalty_rev').catch(() => {}); console.error('Loyalty reversal skipped:', e.message); }
}

export function registerGrowthRoutes(app, { db, tx, secure, v }) {
  const { int, text, money, oneOf } = v;
  const num = (x) => (x == null ? null : Number(x));

  // ================= CUSTOMERS DUE (follow-up alert) =================
  const DUE_SET = ['due', 'at_risk', 'lapsed', 'win_back'];
  app.get('/customers/due', ...secure('customers.view'), async (req, res) => {
    const want = String(req.query.statuses || 'due,at_risk').split(',').map((x) => x.trim()).filter(Boolean);
    for (const s of want) oneOf(s, DUE_SET, 'status');
    const r = await db.query(
      `SELECT m.customer_id, m.full_name, m.phone, m.lifecycle_status, m.status, m.visits, m.total_spend, m.last_visit::text AS last_visit, m.expected_next_visit::text AS expected_next,
              m.days_since_last_visit, m.marketing_consent, m.opted_out_at,
              (SELECT MAX(n.created_at) FROM customer_notes n WHERE n.customer_id = m.customer_id AND n.note LIKE 'Follow-up:%') AS contacted_at
         FROM v_customer_metrics m
        WHERE m.lifecycle_status = ANY($1::text[]) AND m.visits > 0
          AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.customer_id = m.customer_id AND a.starts_at > now() AND a.status IN ('booked','confirmed'))
        ORDER BY m.days_since_last_visit DESC NULLS LAST LIMIT 300`, [want]);
    const counts = await db.query(
      `SELECT m.lifecycle_status AS s, COUNT(*) AS n FROM v_customer_metrics m WHERE m.visits > 0 AND m.lifecycle_status = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.customer_id = m.customer_id AND a.starts_at > now() AND a.status IN ('booked','confirmed'))
        GROUP BY m.lifecycle_status`, [DUE_SET]);
    const c = Object.fromEntries(DUE_SET.map((s) => [s, 0])); for (const x of counts.rows) c[x.s] = Number(x.n);
    res.json({ counts: c, rows: r.rows.map((x) => ({ id: Number(x.customer_id), name: x.full_name, phone: x.phone, status: x.lifecycle_status, vip: x.status === 'vip', visits: Number(x.visits), spend: Number(x.total_spend),
      lastVisit: x.last_visit, expectedNext: x.expected_next, daysSince: num(x.days_since_last_visit), consent: !!x.marketing_consent && !x.opted_out_at, contactedAt: x.contacted_at || null })) });
  });
  app.post('/customers/:id/contacted', ...secure('customers.manage'), async (req, res) => {
    const id = int(req.params.id, 'customer'), how = oneOf(req.body?.channel ?? 'whatsapp', ['whatsapp', 'sms', 'call', 'other'], 'channel');
    await tx({ userId: req.user.id, reason: 'Follow-up contact' }, (c) => c.query(`INSERT INTO customer_notes (customer_id, note, created_by) VALUES ($1, $2, $3)`, [id, `Follow-up: contacted by ${how}`, req.user.id]));
    res.status(201).json({ ok: true });
  });

  // ================= LOYALTY =================
  app.get('/loyalty/overview', ...secure('customers.view'), async (req, res) => {
    const rules = await loadRules(db);
    const top = await db.query(`SELECT c.id, c.full_name, c.phone, a.points_balance, a.lifetime_points FROM loyalty_accounts a JOIN customers c ON c.id = a.customer_id
                                 WHERE c.deleted_at IS NULL AND a.points_balance <> 0 ORDER BY a.points_balance DESC, c.full_name LIMIT 25`);
    const tot = await db.query(`SELECT COALESCE(SUM(points_balance) FILTER (WHERE points_balance > 0), 0) AS outstanding, COUNT(*) FILTER (WHERE points_balance > 0) AS members FROM loyalty_accounts`);
    const o = Number(tot.rows[0]?.outstanding || 0);
    res.json({ rules, canManage: req.user.permissions.has('marketing.manage'), outstandingPoints: o, outstandingValue: o * rules.pointValue, members: Number(tot.rows[0]?.members || 0),
      top: top.rows.map((x) => ({ id: Number(x.id), name: x.full_name, phone: x.phone, balance: Number(x.points_balance), lifetime: Number(x.lifetime_points), value: Number(x.points_balance) * rules.pointValue })) });
  });
  app.put('/loyalty/rules', ...secure('marketing.manage'), async (req, res) => {
    const b = req.body || {};
    const spend = money(b.spendPerPoint ?? 0, 'Spend per point'), visit = Math.round(money(b.pointsPerVisit ?? 0, 'Points per visit')), bday = Math.round(money(b.birthdayBonus ?? 0, 'Birthday bonus'));
    const value = money(b.pointValue ?? 1, 'Value of a point'), minR = Math.round(money(b.minRedeem ?? 0, 'Minimum to redeem'));
    if (value <= 0) throw new AppError(422, 'BAD_VALUE', 'A point must be worth more than 0');
    await tx({ userId: req.user.id, reason: 'Change loyalty rules' }, async (c) => {
      const set = async (type, params, on) => {
        const u = await c.query(`UPDATE loyalty_rules SET params = $2::jsonb, is_active = $3 WHERE rule_type = $1`, [type, JSON.stringify(params), on]);
        if (!u.rowCount) await c.query(`INSERT INTO loyalty_rules (rule_type, params, is_active) VALUES ($1, $2::jsonb, $3)`, [type, JSON.stringify(params), on]);
      };
      await set('points_per_spend', { spend_per_point: spend }, spend > 0); await set('points_per_visit', { points: visit }, visit > 0); await set('birthday_bonus', { points: bday }, bday > 0);
      for (const [k, val] of [['loyalty.point_value', value], ['loyalty.min_redeem', minR]]) {
        await c.query(`INSERT INTO app_settings (branch_id, key, value, updated_by) VALUES (NULL, $1, $2::jsonb, $3)
                       ON CONFLICT (COALESCE(branch_id, 0), key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [k, JSON.stringify(val), req.user.id]);
      }
    });
    res.json({ rules: await loadRules(db) });
  });
  app.get('/customers/:id/loyalty', ...secure('customers.view'), async (req, res) => {
    const id = int(req.params.id, 'customer'), rules = await loadRules(db);
    const a = await db.query(`SELECT id, points_balance, lifetime_points FROM loyalty_accounts WHERE customer_id = $1`, [id]);
    const h = a.rowCount ? await db.query(`SELECT points, reason, created_at FROM loyalty_transactions WHERE account_id = $1 ORDER BY id DESC LIMIT 25`, [a.rows[0].id]) : { rows: [] };
    const bal = Number(a.rows[0]?.points_balance || 0);
    res.json({ balance: bal, lifetime: Number(a.rows[0]?.lifetime_points || 0), value: bal * rules.pointValue, pointValue: rules.pointValue, minRedeem: rules.minRedeem,
      history: h.rows.map((x) => ({ points: Number(x.points), reason: x.reason, at: x.created_at })) });
  });
  app.post('/customers/:id/loyalty/redeem', ...secure('customers.manage'), async (req, res) => {
    const id = int(req.params.id, 'customer'), pts = int(req.body?.points, 'Points');
    const out = await tx({ userId: req.user.id, reason: 'Redeem loyalty points' }, async (c) => {
      const rules = await loadRules(c), acct = await accountFor(c, id, true);
      if (pts <= 0) throw new AppError(422, 'BAD_POINTS', 'Enter the number of points to use');
      if (pts < rules.minRedeem) throw new AppError(422, 'BELOW_MINIMUM', `The minimum to redeem is ${rules.minRedeem} points`);
      if (pts > Number(acct.points_balance)) throw new AppError(422, 'NOT_ENOUGH_POINTS', `Only ${acct.points_balance} points available`);
      await addPoints(c, acct, -pts, 'Redeemed against a sale');
      return { redeemed: pts, discountValue: pts * rules.pointValue, balance: Number(acct.points_balance) - pts };
    });
    res.json(out);
  });
  app.post('/customers/:id/loyalty/adjust', ...secure('marketing.manage'), async (req, res) => {
    const id = int(req.params.id, 'customer'), pts = Math.round(Number(req.body?.points)), why = text(req.body?.reason, 'A reason');
    if (!Number.isFinite(pts) || pts === 0) throw new AppError(422, 'BAD_POINTS', 'Enter points to add (or a negative number to remove)');
    const out = await tx({ userId: req.user.id, reason: 'Adjust loyalty points: ' + why }, async (c) => {
      const acct = await accountFor(c, id, true); await addPoints(c, acct, pts, 'Adjustment: ' + why);
      return { balance: Number(acct.points_balance) + pts };
    });
    res.json(out);
  });

  // ================= MARKETING CAMPAIGNS =================
  // A campaign is a saved audience + message. Audience: customers whose status is in the chosen list, who agreed to marketing,
  // have not opted out and have a phone number. Optionally only those with a birthday this month.
  const parseAudience = (b) => {
    const statuses = Array.isArray(b.statuses) ? b.statuses.map((s) => oneOf(s, SEGMENT_STATUSES, 'status')) : [];
    if (!statuses.length && !b.birthdayThisMonth) throw new AppError(422, 'AUDIENCE_REQUIRED', 'Choose who to message (at least one customer group)');
    return { statuses, birthdayThisMonth: b.birthdayThisMonth === true };
  };
  const audienceSql = `FROM v_customer_metrics m
     WHERE m.marketing_consent AND m.opted_out_at IS NULL AND m.phone IS NOT NULL AND length(trim(m.phone)) > 0
       AND (cardinality($1::text[]) = 0 OR m.status = ANY($1))
       AND (NOT $2::boolean OR (m.birthday IS NOT NULL AND EXTRACT(month FROM m.birthday) = EXTRACT(month FROM business_today())))`;
  app.post('/campaigns/audience', ...secure('marketing.view'), async (req, res) => {
    const a = parseAudience(req.body || {});
    const r = await db.query(`SELECT m.customer_id, m.full_name, m.phone, m.status ${audienceSql} ORDER BY m.full_name LIMIT 10`, [a.statuses, a.birthdayThisMonth]);
    const n = await db.query(`SELECT COUNT(*) AS n ${audienceSql}`, [a.statuses, a.birthdayThisMonth]);
    const skipped = await db.query(`SELECT COUNT(*) AS n FROM v_customer_metrics m WHERE (cardinality($1::text[]) = 0 OR m.status = ANY($1)) AND NOT (m.marketing_consent AND m.opted_out_at IS NULL)`, [a.statuses]);
    res.json({ count: Number(n.rows[0]?.n || 0), noConsent: Number(skipped.rows[0]?.n || 0), sample: r.rows.map((x) => ({ id: Number(x.customer_id), name: x.full_name, status: x.status })) });
  });
  app.get('/campaigns', ...secure('marketing.view'), async (req, res) => {
    const r = await db.query(
      `SELECT c.id, c.name, c.channel, c.status, c.created_at, c.attribution_window_days, p.audience, p.sent, p.replies, p.opt_outs, p.bookings, p.completed_visits, p.revenue,
              (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'queued') AS queued
         FROM marketing_campaigns c LEFT JOIN v_campaign_performance p ON p.campaign_id = c.id ORDER BY c.id DESC LIMIT 100`);
    res.json({ canManage: req.user.permissions.has('marketing.manage'), rows: r.rows.map((x) => ({ id: Number(x.id), name: x.name, channel: x.channel, status: x.status, createdAt: x.created_at, windowDays: Number(x.attribution_window_days),
      audience: Number(x.audience || 0), sent: Number(x.sent || 0), queued: Number(x.queued || 0), replies: Number(x.replies || 0), optOuts: Number(x.opt_outs || 0), bookings: Number(x.bookings || 0), visits: Number(x.completed_visits || 0), revenue: Number(x.revenue || 0) })) });
  });
  app.post('/campaigns', ...secure('marketing.manage'), async (req, res) => {
    const b = req.body || {}, name = text(b.name, 'Campaign name'), channel = oneOf(b.channel ?? 'whatsapp', ['whatsapp', 'sms'], 'channel'), tpl = text(b.message, 'The message');
    if (tpl.length > 600) throw new AppError(422, 'TOO_LONG', 'Keep the message under 600 characters');
    const a = parseAudience(b), win = Math.round(Number(b.attributionDays) || 14);
    if (win < 1 || win > 90) throw new AppError(422, 'BAD_WINDOW', 'Result tracking window must be 1 to 90 days');
    const out = await tx({ userId: req.user.id, reason: 'Create campaign' }, async (c) => {
      const seg = await c.query(`INSERT INTO marketing_segments (name, definition, is_dynamic, created_by) VALUES ($1, $2::jsonb, false, $3) RETURNING id`,
        [`${name} (${new Date().toISOString()})`, JSON.stringify(a), req.user.id]);
      const camp = await c.query(`INSERT INTO marketing_campaigns (name, channel, segment_id, message_template, status, attribution_window_days, created_by) VALUES ($1, $2, $3, $4, 'draft', $5, $6) RETURNING id`,
        [name, channel, seg.rows[0].id, tpl, win, req.user.id]);
      const ins = await c.query(`INSERT INTO campaign_recipients (campaign_id, customer_id, phone) SELECT $3::bigint, m.customer_id, m.phone ${audienceSql} ON CONFLICT (campaign_id, customer_id) DO NOTHING`, [a.statuses, a.birthdayThisMonth, camp.rows[0].id]);
      if (!ins.rowCount) throw new AppError(422, 'EMPTY_AUDIENCE', 'Nobody matches: customers must have agreed to marketing and have a phone number');
      await c.query(`UPDATE marketing_campaigns SET status = 'sending' WHERE id = $1`, [camp.rows[0].id]);
      return { id: Number(camp.rows[0].id), recipients: ins.rowCount };
    });
    res.status(201).json(out);
  });
  app.get('/campaigns/:id', ...secure('marketing.view'), async (req, res) => {
    const id = int(req.params.id, 'campaign');
    const c = await db.query(`SELECT id, name, channel, status, message_template, attribution_window_days FROM marketing_campaigns WHERE id = $1`, [id]);
    if (!c.rowCount) throw new AppError(404, 'NOT_FOUND', 'Campaign not found');
    const r = await db.query(`SELECT r.id, r.customer_id, r.phone, r.status, r.sent_at, cu.full_name FROM campaign_recipients r JOIN customers cu ON cu.id = r.customer_id WHERE r.campaign_id = $1 ORDER BY (r.status = 'queued') DESC, cu.full_name LIMIT 1000`, [id]);
    const x = c.rows[0], salon = (await loadBusiness(db)).name;
    res.json({ id, name: x.name, channel: x.channel, status: x.status, template: x.message_template, canManage: req.user.permissions.has('marketing.manage'),
      recipients: r.rows.map((y) => ({ id: Number(y.id), customerId: Number(y.customer_id), name: y.full_name, phone: y.phone, status: y.status, sentAt: y.sent_at, message: renderMessage(x.message_template, y.full_name, salon) })) });
  });
  const recipientAction = (path, fn) => app.post(`/campaigns/:id/recipients/:rid/${path}`, ...secure('marketing.manage'), async (req, res) => {
    const id = int(req.params.id, 'campaign'), rid = int(req.params.rid, 'recipient');
    const out = await tx({ userId: req.user.id, reason: `Campaign ${path}` }, async (c) => {
      const r = await c.query(`SELECT customer_id, status FROM campaign_recipients WHERE id = $1 AND campaign_id = $2 FOR UPDATE`, [rid, id]);
      if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Recipient not found');
      await fn(c, r.rows[0], rid);
      const left = await c.query(`SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = $1 AND status = 'queued'`, [id]);
      if (Number(left.rows[0].n) === 0) await c.query(`UPDATE marketing_campaigns SET status = 'sent' WHERE id = $1 AND status = 'sending'`, [id]);
      return { ok: true };
    });
    res.json(out);
  });
  recipientAction('sent', (c, r, rid) => c.query(`UPDATE campaign_recipients SET status = 'sent', sent_at = COALESCE(sent_at, now()) WHERE id = $1 AND status = 'queued'`, [rid]));
  recipientAction('replied', (c, r, rid) => c.query(`UPDATE campaign_recipients SET status = 'replied', replied_at = now(), sent_at = COALESCE(sent_at, now()) WHERE id = $1`, [rid]));
  recipientAction('opted-out', async (c, r, rid) => {
    await c.query(`UPDATE campaign_recipients SET status = 'opted_out' WHERE id = $1`, [rid]);
    await c.query(`UPDATE customers SET marketing_consent = false, whatsapp_consent = false, sms_consent = false, opted_out_at = now() WHERE id = $1`, [r.customer_id]);
  });
  app.post('/campaigns/:id/cancel', ...secure('marketing.manage'), async (req, res) => {
    const id = int(req.params.id, 'campaign');
    const r = await tx({ userId: req.user.id, reason: 'Cancel campaign' }, (c) => c.query(`UPDATE marketing_campaigns SET status = 'cancelled' WHERE id = $1 AND status IN ('draft','sending','scheduled')`, [id]));
    if (!r.rowCount) throw new AppError(409, 'CANNOT_CANCEL', 'This campaign cannot be cancelled');
    res.json({ ok: true });
  });
}
