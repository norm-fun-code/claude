// Explicit, revocable, per-capability consent for auto_act — see
// migrations/043_attention.sql. Default-deny: a capability with no active
// grant row is never eligible for auto_act, full stop. Never inferred from a
// read scope or from any other signal — only an explicit grant() call counts.
const { query } = require('../db');

/** Active (non-revoked) capability ids, as a Set — what the policy checks
 *  event.action.capabilityId against. Fail-safe empty on error, matching the
 *  default-deny posture: a ledger hiccup must never accidentally grant. */
async function activeGrants() {
  try {
    const { rows } = await query(`SELECT capability_id FROM consent_grants WHERE revoked_at IS NULL`);
    return new Set(rows.map((r) => r.capability_id));
  } catch {
    return new Set();
  }
}

async function grant(capabilityId) {
  await query(
    `INSERT INTO consent_grants (capability_id) VALUES ($1)
       ON CONFLICT (capability_id) DO UPDATE SET granted_at = now(), revoked_at = NULL`,
    [capabilityId]
  );
}

async function revoke(capabilityId) {
  await query(`UPDATE consent_grants SET revoked_at = now() WHERE capability_id = $1 AND revoked_at IS NULL`, [capabilityId]);
}

module.exports = { activeGrants, grant, revoke };
