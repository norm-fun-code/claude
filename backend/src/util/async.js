// Small async helpers shared across services.

/**
 * Resolve `promise`, but reject (or fall back) if it doesn't settle within
 * `ms`. Protects callers like the briefing — which fan out to several external
 * APIs via Promise.allSettled — from a single upstream that hangs forever
 * (allSettled waits for every promise, so one stall blocks the whole response).
 *
 * @param {Promise} promise
 * @param {number} ms timeout in milliseconds
 * @param {string} label for the timeout error message
 * @returns {Promise} rejects with an Error('<label> timed out after <ms>ms')
 */
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };
