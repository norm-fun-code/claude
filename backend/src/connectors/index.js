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
const monarchApi = require('./monarch-api');
const notion = require('./notion');

// Wealth source: Monarch. The auto-sync connector (./monarch-api) pulls daily
// from Monarch's API when MONARCH_EMAIL/PASSWORD are set; the CSV importer
// (./monarch) stays as a manual fallback. Both write source 'monarch', so they
// upsert idempotently and never double-count. Plaid (./plaid) is kept dormant.
const connectors = [calendar, weather, readwise, monarch, monarchApi, notion];

function getConnector(id) {
  return connectors.find((c) => c.id === id) || null;
}

module.exports = { connectors, getConnector };
