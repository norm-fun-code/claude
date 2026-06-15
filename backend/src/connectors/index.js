// Connector registry. Each connector implements:
//   { id, domain, displayName, async sync(ctx) -> { metrics, documents, config? } }
// ctx = { lastSyncAt, config } lets connectors do incremental syncs and persist
// cursors. Add new server-pulled sources here as they're built.
//
// Note: Apple Health is device-pushed (mobile app -> POST /api/ingest/health),
// not a server-pulled connector, so it isn't listed here.
const calendar = require('./calendar');
const weather = require('./weather');
const readwise = require('./readwise');
const monarch = require('./monarch');
const monarchMcpSync = require('./monarch-mcp-sync');
const notion = require('./notion');
const eightSleep = require('./eight-sleep');

// Wealth source: Monarch. The MCP auto-sync connector (./monarch-mcp-sync) is the
// PRIMARY source — it pulls authoritative numbers from Monarch's official MCP
// server (matching Monarch's own UI). It internally falls back to the GraphQL
// connector (./monarch-api) when Monarch MCP isn't configured or a pull fails.
// The CSV importer (./monarch) stays as a manual fallback. All write source
// 'monarch', so they upsert idempotently and never double-count.
//
// Health source: Eight Sleep auto-sync (./eight-sleep) pulls last night's
// session each morning when EIGHT_SLEEP_EMAIL/PASSWORD are set; writes source
// 'eight_sleep', idempotent with manual /api/ingest/sleep entries.
const connectors = [calendar, weather, readwise, monarch, monarchMcpSync, notion, eightSleep];

function getConnector(id) {
  return connectors.find((c) => c.id === id) || null;
}

module.exports = { connectors, getConnector };
