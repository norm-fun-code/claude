// `npm run doctor` — a plain-language readiness check. Tells you what's working
// and what still needs a key or a step, so turning NormOS on is never guesswork.
// Read-only and safe: never writes, never throws — it just reports.
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { pool } = require('./db');
const llm = require('./llm');

const GREEN = '\x1b[32m', RED = '\x1b[31m', YEL = '\x1b[33m', DIM = '\x1b[2m', RST = '\x1b[0m';
const ok = (s) => `${GREEN}✓${RST} ${s}`;
const no = (s) => `${RED}✗${RST} ${s}`;
const meh = (s) => `${YEL}•${RST} ${s}`;
const has = (k) => Boolean(process.env[k] && process.env[k].trim());

async function main() {
  const lines = [];
  let blocking = 0;

  // --- Database -------------------------------------------------------------
  lines.push('\nDATABASE');
  let dbUp = false;
  try {
    const r = await pool.query('SELECT 1');
    dbUp = r.rows.length === 1;
  } catch (err) {
    lines.push('  ' + no(`Postgres not reachable — ${err.message}`));
    lines.push('    ' + DIM + 'Start it: docker compose up -d   (then: npm run migrate)' + RST);
    blocking++;
  }
  if (dbUp) {
    lines.push('  ' + ok('Postgres reachable'));
    try {
      const { rows } = await pool.query(
        `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`
      );
      const migrated = rows[0].n >= 10;
      lines.push('  ' + (migrated ? ok(`schema present (${rows[0].n} tables)`) : no('schema not migrated — run: npm run migrate')));
      if (!migrated) blocking++;

      const counts = {};
      for (const t of ['metrics', 'documents', 'findings', 'goals']) {
        try { counts[t] = (await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n; }
        catch { counts[t] = 0; }
      }
      const dataLine = `data: ${counts.metrics} metrics, ${counts.documents} documents, ${counts.findings} findings, ${counts.goals} goals`;
      lines.push('  ' + (counts.metrics > 0 ? ok(dataLine) : meh(dataLine + '  → try: npm run seed (demo) or npm run ingest')));
    } catch (err) {
      lines.push('  ' + no(`schema check failed: ${err.message}`));
    }
  }

  // --- AI models ------------------------------------------------------------
  lines.push('\nAI MODELS');
  const chat = (() => { try { return llm.chatProviderName(); } catch { return 'none'; } })();
  const embed = (() => { try { return llm.embedProviderName(); } catch { return 'none'; } })();
  const chatReady = (chat === 'anthropic' && has('ANTHROPIC_API_KEY')) ||
    (chat === 'gemini' && has('GEMINI_API_KEY')) || chat === 'ollama';
  const embedReady = (embed === 'gemini' && has('GEMINI_API_KEY')) || embed === 'ollama';
  lines.push('  ' + (chatReady ? ok(`chat/reasoning → ${chat}`) : no(`chat/reasoning → ${chat} (set the API key)`)));
  if (!chatReady) blocking++;
  lines.push('  ' + (embedReady ? ok(`embeddings → ${embed}`) : meh(`embeddings → ${embed} (needed for library search/chat)`)));

  // --- Connectors -----------------------------------------------------------
  lines.push('\nCONNECTORS (data sources)');
  const monarchDir = process.env.MONARCH_IMPORT_DIR || path.join(__dirname, '..', 'imports', 'monarch');
  const monarchFiles = (() => { try { return fs.readdirSync(monarchDir).filter((f) => f.endsWith('.csv')).length; } catch { return 0; } })();
  const connectors = [
    ['Monarch (wealth)', monarchFiles > 0, `${monarchFiles} CSV(s) in ${monarchDir}`, 'drop a Monarch export there'],
    ['Readwise (learning)', has('READWISE_TOKEN'), 'token set', 'set READWISE_TOKEN'],
    ['Notion (learning)', has('NOTION_API_KEY'), 'key set', 'set NOTION_API_KEY'],
    ['Google Calendar', has('GOOGLE_REFRESH_TOKEN'), 'OAuth token set', 'run npm run get-tokens'],
    ['Gmail (briefing)', has('GOOGLE_REFRESH_TOKEN'), 'OAuth token set', 'run npm run get-tokens'],
    ['Weather', has('WEATHERKIT_TEAM_ID') || has('OPENWEATHER_API_KEY'), 'configured', 'set OPENWEATHER_API_KEY (free)'],
  ];
  for (const [name, ready, okMsg, hint] of connectors) {
    lines.push('  ' + (ready ? ok(`${name}: ${okMsg}`) : meh(`${name}: not set — ${hint}`)));
  }
  lines.push('  ' + DIM + 'Apple Health is device-pushed from the phone app (no key here).' + RST);

  // --- Notifications --------------------------------------------------------
  lines.push('\nPROACTIVE NUDGES');
  if (dbUp) {
    try {
      const n = (await pool.query(`SELECT count(*)::int n FROM devices WHERE active=true`)).rows[0].n;
      lines.push('  ' + (n > 0 ? ok(`${n} device(s) registered for push`) : meh('no devices yet — open the app on your phone to register')));
    } catch { /* table missing pre-migrate */ }
  }
  lines.push('  ' + (has('NORMOS_API_TOKEN') ? ok('API auth enabled (NORMOS_API_TOKEN set)') : meh('API auth off (fine for localhost; set NORMOS_API_TOKEN for a VPS)')));

  // --- Verdict --------------------------------------------------------------
  lines.push('');
  lines.push(blocking === 0
    ? `${GREEN}NormOS is ready.${RST} Start the server: npm start`
    : `${YEL}${blocking} blocking item(s) above.${RST} Fix those, then: npm run doctor`);

  console.log(lines.join('\n'));
}

main()
  .catch((err) => { console.error('doctor failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
