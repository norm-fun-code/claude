// Proactive-nudge runner: read the current findings, decide what (if anything)
// is worth interrupting the day for, persist it, and push it to the phone.
//
// Use as a CLI on a morning schedule (`npm run nudge` via cron/launchd at ~7am)
// or trigger via POST /api/nudges/run. Honors quiet hours unless forced.
require('dotenv').config();
const { query } = require('../db');
const findingsStore = require('../store/findings');
const nudgesStore = require('../store/nudges');
const devicesStore = require('../store/devices');
const { buildNudges, withinQuietHours } = require('../intelligence/nudges');
const { sendPush } = require('./expo');

/** Has the subjective check-in been logged today? Fail-safe: assume yes on error
 *  so we never nag the user because of a DB hiccup. */
async function checkinLoggedToday(asOf = new Date()) {
  try {
    const { rows } = await query(
      `SELECT 1 FROM metrics WHERE source = 'checkin' AND ts::date = $1::date LIMIT 1`,
      [asOf.toISOString().slice(0, 10)]
    );
    return rows.length > 0;
  } catch {
    return true;
  }
}

/**
 * @param {{ asOf?: Date, send?: boolean, force?: boolean, dedupDays?: number }} [opts]
 */
async function runNudges(opts = {}) {
  const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
  const send = opts.send !== false;
  const dedupDays = opts.dedupDays ?? 2;

  if (!opts.force && withinQuietHours(asOf)) {
    return { skipped: 'quiet_hours', generated: 0, sent: 0 };
  }

  const findings = await findingsStore.listFindings({ status: 'open', limit: 200 });
  const recentKeys = await nudgesStore.recentlySentKeys(dedupDays);
  const hasCheckinToday = await checkinLoggedToday(asOf);
  const candidates = buildNudges({ findings, recentKeys, hasCheckinToday, asOf });

  if (candidates.length === 0) {
    return { generated: 0, sent: 0, nudges: [] };
  }

  const tokens = send ? await devicesStore.listActiveTokens() : [];
  let sentCount = 0;
  const out = [];

  for (const n of candidates) {
    const status = send && tokens.length === 0 ? 'skipped' : 'pending';
    const id = await nudgesStore.recordNudge({ ...n, dedupKey: n.key, status });

    if (send && tokens.length > 0) {
      try {
        const r = await sendPush(tokens, { title: n.title, body: n.body, data: { key: n.key } });
        for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
        await nudgesStore.markStatus(id, 'sent');
        sentCount += 1;
      } catch (err) {
        await nudgesStore.markStatus(id, 'failed');
        out.push({ ...n, error: err.message });
        continue;
      }
    }
    out.push(n);
  }

  return { generated: candidates.length, sent: sentCount, devices: tokens.length, nudges: out };
}

module.exports = { runNudges };

// CLI entrypoint
if (require.main === module) {
  const { pool } = require('../db');
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  runNudges({ force, send: !dryRun })
    .then((s) => {
      if (s.skipped) return console.log(`Skipped (${s.skipped}).`);
      console.log(`Generated ${s.generated} nudge(s), sent ${s.sent} to ${s.devices ?? 0} device(s).`);
      for (const n of s.nudges) console.log(`  • [${n.priority}] ${n.title}: ${n.body}${n.error ? ` (error: ${n.error})` : ''}`);
    })
    .catch((err) => {
      console.error('Nudge run failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
