// Registered push targets (Expo push tokens) for proactive nudges.
const { query } = require('../db');

/** Register (or refresh) a device's push token. Idempotent on the token. */
async function registerDevice({ pushToken, platform = null, label = null }) {
  if (!pushToken) return null;
  const { rows } = await query(
    `INSERT INTO devices (push_token, platform, label)
     VALUES ($1, $2, $3)
     ON CONFLICT (push_token) DO UPDATE
       SET active = true,
           platform = COALESCE(EXCLUDED.platform, devices.platform),
           label = COALESCE(EXCLUDED.label, devices.label),
           last_seen_at = now()
     RETURNING id`,
    [pushToken, platform, label]
  );
  return rows[0]?.id ?? null;
}

/** Active push tokens to send to. */
async function listActiveTokens() {
  const { rows } = await query(
    `SELECT push_token FROM devices WHERE active = true ORDER BY last_seen_at DESC`
  );
  return rows.map((r) => r.push_token);
}

/** Mark a token inactive (e.g. Expo reported it as unregistered). */
async function deactivate(pushToken) {
  await query(`UPDATE devices SET active = false WHERE push_token = $1`, [pushToken]);
}

module.exports = { registerDevice, listActiveTokens, deactivate };
