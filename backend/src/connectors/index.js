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
const notion = require('./notion');

// Wealth source: Monarch (monthly CSV import) is primary — it aggregates every
// institution plus manual accounts Plaid can't see. The Plaid connector
// (./plaid) is kept in the codebase but dormant (not registered) so the two
// never double-count; re-add it here if you ever want intra-month freshness.
const connectors = [calendar, weather, readwise, monarch, notion];

function getConnector(id) {
  return connectors.find((c) => c.id === id) || null;
}

module.exports = { connectors, getConnector };
