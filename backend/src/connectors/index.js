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
const plaid = require('./plaid');
const notion = require('./notion');

const connectors = [calendar, weather, readwise, plaid, notion];

function getConnector(id) {
  return connectors.find((c) => c.id === id) || null;
}

module.exports = { connectors, getConnector };
