// Small env-var parsing helpers. Exists because `Number(process.env.X) || fallback`
// is a genuine bug for any config value that's legitimately 0 — e.g.
// SCHEDULE_HOUR=0 (midnight) or SCHEDULE_MINUTE=0 (on the hour) would
// silently fall back to the default instead, since `0 || fallback` is always
// `fallback` in JS. envInt only falls back when the var is unset, empty, or
// not a finite number — never because the parsed value happens to be 0.
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { envInt };
