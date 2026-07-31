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

/**
 * Fetch with a real transport deadline.  `withTimeout()` is appropriate for a
 * computation whose result we can safely stop waiting for, but it cannot stop
 * a hanging network socket.  Scheduled work needs the latter: a provider that
 * never responds must produce a terminal failure so the next retry can run.
 */
async function fetchWithTimeout(url, opts = {}, ms = 15_000, label = 'request') {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Number(ms) || 15_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      const timeout = new Error(`${label} timed out after ${timeoutMs}ms`);
      timeout.code = 'ETIMEDOUT';
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { withTimeout, fetchWithTimeout };
