// Attention-policy ledger — see migrations/043_attention.sql. Backs the
// dedup/cooldown check, the novelty ledger, the daily interruption budget,
// and the audit trail + outcome stamps the beliefs layer learns from. All
// reads are fail-safe (empty/zero on error) so a ledger hiccup degrades the
// policy toward its conservative defaults (no recent keys known -> treated
// as novel; budget unreadable -> treated as under budget) rather than ever
// throwing out of a watcher/nudge run.
const { query, withTransaction } = require('../db');
const { eventKey, cooldownHoursFor } = require('../intelligence/attention');

/** Persist one judged decision. Uses the same transaction-scoped advisory
 *  lock pattern as store/nudges.js's recordNudge — closes the identical
 *  check-then-insert race for concurrent dispatches of the same event_key
 *  (e.g. an overlapping scheduler tick). Returns the inserted row's id. */
async function record({ event, decision, delivered = false, deliveredChannel = null }) {
  const key = eventKey(event);
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    const { rows } = await client.query(
      `INSERT INTO attention_log
         (event_key, source, domain, type, subject, disposition, reason, scores, gates, delivered, delivered_channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)
       RETURNING id`,
      [
        key, event.source, event.domain, event.type, event.subject,
        decision.disposition, decision.reason,
        JSON.stringify(decision.scores || {}), JSON.stringify(decision.gates || {}),
        delivered, deliveredChannel,
      ]
    );
    return rows[0]?.id ?? null;
  });
}

/** event_key -> "surfaced to the user recently enough that the SAME fact
 *  should stay suppressed". Per-type cooldown (attention.js's
 *  COOLDOWN_HOURS_BY_TYPE), queried as one set covering the longest relevant
 *  window, then filtered per-row by that event's own type cooldown — a
 *  single query rather than N per-type queries. */
async function recentKeys({ types = null, days = 31 } = {}) {
  try {
    const { rows } = await query(
      `SELECT event_key, type, created_at FROM attention_log
        WHERE disposition IN ('notify_now','offer_action','auto_act','add_to_brief','ask_question')
          AND created_at >= now() - ($1 || ' days')::interval
          AND ($2::text[] IS NULL OR type = ANY($2))
        ORDER BY created_at DESC`,
      [String(days), types]
    );
    const now = Date.now();
    const keys = new Set();
    for (const r of rows) {
      if (keys.has(r.event_key)) continue; // newest row per key already checked (ORDER BY DESC)
      const hoursSince = (now - new Date(r.created_at).getTime()) / 3600000;
      if (hoursSince < cooldownHoursFor(r.type)) keys.add(r.event_key);
    }
    return keys;
  } catch {
    return new Set();
  }
}

/** How many notify_now/offer_action/auto_act rows already spent today's
 *  interruption budget. Auto_act with a 'brief' delivery channel (deferred
 *  because it was quiet) does not count — only actual interruptions do. */
async function budgetUsedToday({ tz = process.env.TZ || 'America/New_York' } = {}) {
  try {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM attention_log
        WHERE disposition IN ('notify_now','offer_action','auto_act')
          AND delivered_channel = 'push'
          AND (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
      [tz]
    );
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

/** How many of today's critical-reserve slots are already spent. Counts only
 *  rows that ACTUALLY consumed the reserve (the bypass fired) — not every event
 *  judged critical. A critical event that fell through to normal scoring (on
 *  cooldown, or the reserve already spent) carries gates.critical_override for
 *  audit but must NOT count against the reserve it never used. */
async function criticalUsedToday({ tz = process.env.TZ || 'America/New_York' } = {}) {
  try {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM attention_log
        WHERE gates->>'critical_reserve_consumed' = 'true'
          AND (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
      [tz]
    );
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

/** event_key -> true if EVER seen before (any disposition, any time) — the
 *  raw novelty signal the policy's `novelty` score is 1 minus. */
async function everSeen(keys) {
  if (!keys || !keys.length) return new Set();
  try {
    const { rows } = await query(`SELECT DISTINCT event_key FROM attention_log WHERE event_key = ANY($1)`, [keys]);
    return new Set(rows.map((r) => r.event_key));
  } catch {
    return new Set();
  }
}

/** Stamp the outcome of a previously-logged event (dismissed/ignored/
 *  accepted/completed) — the input the beliefs layer's outcome-feedback
 *  promoter reads. Matches the most recent row for this event_key. */
async function stampOutcome(event, outcome) {
  const key = eventKey(event);
  try {
    await query(
      `UPDATE attention_log SET outcome = $2, outcome_at = now()
        WHERE id = (SELECT id FROM attention_log WHERE event_key = $1 AND outcome IS NULL ORDER BY created_at DESC LIMIT 1)`,
      [key, outcome]
    );
  } catch { /* best-effort — outcome stamping must never break a caller's own flow */ }
}

/** Aggregate recent outcomes per (domain, type, subject) — feeds
 *  beliefs.js's dismissal/ignore-pattern promotion the same way
 *  dismissalPatterns() reads store/dismissedInsights.js today. */
async function outcomeCounts({ days = 30 } = {}) {
  try {
    const { rows } = await query(
      `SELECT domain, type, subject, outcome, count(*)::int AS n
         FROM attention_log
        WHERE outcome IS NOT NULL AND outcome_at >= now() - ($1 || ' days')::interval
        GROUP BY domain, type, subject, outcome`,
      [String(days)]
    );
    return rows;
  } catch {
    return [];
  }
}

/** Today's add_to_brief / ask_question rows — what the next briefing build
 *  should consider surfacing (routes/briefing.js's consumer). */
async function pendingForBrief({ tz = process.env.TZ || 'America/New_York', limit = 8 } = {}) {
  try {
    const { rows } = await query(
      `SELECT event_key, domain, type, subject, disposition, reason, scores
         FROM attention_log
        WHERE disposition IN ('add_to_brief','ask_question')
          AND (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
        ORDER BY (scores->>'value')::float DESC NULLS LAST
        LIMIT $2`,
      [tz, limit]
    );
    return rows;
  } catch {
    return [];
  }
}

module.exports = { record, recentKeys, budgetUsedToday, criticalUsedToday, everSeen, stampOutcome, outcomeCounts, pendingForBrief };
