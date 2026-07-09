// Shared request-validation boundary — see the engineering review's #9.
// Most of the ~40 hand-rolled `if (!x) return res.status(400)...` checks
// scattered across routes are the same shape: "these fields must be present
// and non-empty." This replaces each one-off version with a single, tested
// helper, so a route's validation reads as data (which fields) rather than
// re-implementing the emptiness check and error-response shape every time.
//
// Deliberately NOT a full declarative schema engine (type coercion, enums,
// cross-field rules, nested shapes) — the real checks in this codebase are
// too varied for that to pay off (an OR-of-two-fields check, an ID-format
// check, a check against a dynamic Set, a check on a DB call's result).
// Those stay as bespoke code; this covers the common case cleanly instead
// of forcing every check through a generic schema that would just move the
// same complexity into config.

/**
 * Reject with 400 if any of `fields` is missing/empty in `source`. Treats
 * `undefined`, `null`, and `''` as missing; `0` and `false` are NOT missing
 * (a route needing that distinction should check separately).
 *
 * @returns {boolean} true if valid (caller continues); false if it already
 *   sent the 400 response (caller must `return`).
 */
function requireFields(source, fields, res) {
  const missing = fields.filter((f) => {
    const v = source?.[f];
    return v == null || v === '';
  });
  if (missing.length) {
    res.status(400).json({ error: `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required` });
    return false;
  }
  return true;
}

module.exports = { requireFields };
