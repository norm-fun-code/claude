// Shared bearer-token gate factory. Used both for the general /api auth (in
// server.js) and for the stricter admin/diagnostic gate (src/middleware/
// adminAuth.js) — same constant-time-compare logic, different secret and
// different unconfigured-token behavior.
const crypto = require('crypto');

/**
 * @param {string} envVar - env var holding the expected token.
 * @param {object} [opts]
 * @param {(req: import('express').Request) => boolean} [opts.skip] - requests
 *   for which this gate always passes (e.g. the health check).
 * @param {boolean} [opts.failClosedInProd] - if true, an unconfigured token
 *   rejects every non-skipped request in production instead of allowing all.
 */
function createTokenGate(envVar, { skip, failClosedInProd = false } = {}) {
  return function tokenGate(req, res, next) {
    if (skip && skip(req)) return next();
    const token = process.env[envVar];
    if (!token) {
      if (failClosedInProd && process.env.NODE_ENV === 'production') {
        return res.status(503).json({ error: `${envVar} not configured` });
      }
      return next();
    }
    const auth = req.get('authorization') || '';
    const expected = `Bearer ${token}`;
    // Constant-time compare to avoid a timing side-channel on the token.
    const a = Buffer.from(auth);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };
}

module.exports = { createTokenGate };
