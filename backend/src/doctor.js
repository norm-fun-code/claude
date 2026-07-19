// `npm run doctor` — a plain-language readiness check. Tells you what's working
// and what still needs a key or a step, so turning NormOS on is never guesswork.
// Read-only and safe: never writes, never throws — it just reports.
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { pool } = require('./db');
const llm = require('./llm');
const { hasChatLLM } = require('./config/checkEnv');

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
  const chatReady = hasChatLLM();
  const embedReady = embed === 'gemini' && has('GEMINI_API_KEY');
  lines.push('  ' + (chatReady ? ok(`chat/reasoning → ${chat}`) : no(`chat/reasoning → ${chat} (set the API key)`)));
  if (!chatReady) blocking++;
  lines.push('  ' + (embedReady ? ok(`embeddings → ${embed}`) : meh(`embeddings → ${embed} (needed for library search/chat)`)));

  // --- Voice (TTS) ------------------------------------------------------------
  // Live bug this section exists to catch early: GEMINI_TTS_MODEL was set in
  // production to 'gemini-3.5-flash' (a plain text model, not TTS-capable) —
  // every Wisdom/brief/evening "Listen" tap failed until that was found by
  // reading Railway logs by hand. This reports the same thing at a glance,
  // read-only, without ever printing the key.
  lines.push('\nVOICE (TTS — Listen narration)');
  if (!has('GEMINI_API_KEY')) {
    lines.push('  ' + meh('GEMINI_TTS_MODEL/candidates not checked — GEMINI_API_KEY not set (voice/narration is off)'));
  } else {
    try {
      const voice = require('./services/voice');
      const probe = await voice.probeTtsModelAvailability();
      if (probe.configured) {
        lines.push('  ' + (probe.configuredLooksValid
          ? ok(`GEMINI_TTS_MODEL override: ${probe.configured}`)
          : no(`GEMINI_TTS_MODEL override: ${probe.configured} — does NOT look like a TTS model id (no "tts" in the name); it is tried FIRST and will likely fail every call`)));
        if (!probe.configuredLooksValid) blocking++;
      } else {
        lines.push('  ' + meh('GEMINI_TTS_MODEL not set — using the built-in candidate order'));
      }
      lines.push('  ' + DIM + `candidates (in try order): ${voice.TTS_CANDIDATES.join(', ')}` + RST);
      if (probe.error) {
        lines.push('  ' + meh(`could not check live model listing: ${probe.error}`));
      } else if (probe.listed) {
        // "listed" means ListModels can see it for this key — NOT that a real
        // Interactions TTS call will succeed (this doctor never places a paid
        // synthesis call to find out). Live bug this wording exists to
        // prevent recurring: a model was listed here yet still 400'd in
        // production because the actual bug was the request path, not model
        // existence — see services/voice.js's synthesize() header comment.
        lines.push('  ' + (probe.listed.length ? ok(`listed for this key (not a confirmed working call): ${probe.listed.join(', ')}`) : no('NONE of the configured/candidate TTS models are listed for this key')));
        if (probe.notListed?.length) {
          lines.push('  ' + meh(`not listed for this key: ${probe.notListed.join(', ')}`));
        }
        if (!probe.listed.length) blocking++;
      }
    } catch (err) {
      lines.push('  ' + meh(`voice TTS check failed: ${err.message}`));
    }
  }
  // Provider-neutral router config (audit fix: durable OpenAI fallback
  // alongside Gemini preview TTS) — read-only, no live/paid call here (that's
  // what the admin-gated GET /api/diag/tts probe is for); just reports which
  // provider narration will actually try FIRST right now and whether OpenAI
  // has a key configured at all.
  try {
    const ttsProvider = require('./services/ttsProvider');
    const openaiService = require('./services/ttsOpenai');
    const cfg = ttsProvider.describeConfig();
    lines.push('  ' + DIM + `provider router: mode=${cfg.mode} order=[${cfg.order.join(', ')}] primary=${cfg.primary} (model=${cfg.model}, voice=${cfg.voice})` + RST);
    lines.push('  ' + (openaiService.isConfigured()
      ? ok(`OPENAI_API_KEY configured (model=${openaiService.DEFAULT_MODEL}, format=${openaiService.DEFAULT_FORMAT})`)
      : meh('OPENAI_API_KEY not set — OpenAI TTS fallback is unavailable; narration relies on Gemini alone. Use GET /api/diag/tts to live-probe both providers.')));
  } catch (err) {
    lines.push('  ' + meh(`TTS provider router check failed: ${err.message}`));
  }

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
