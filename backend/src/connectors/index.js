// Connector registry. Each connector implements:
//   { id, domain, displayName, async sync() -> { metrics, documents } }
// Add new sources (Oura, Whoop, Readwise, Plaid, ...) here as they're built.
const calendar = require('./calendar');
const weather = require('./weather');

const connectors = [calendar, weather];

function getConnector(id) {
  return connectors.find((c) => c.id === id) || null;
}

module.exports = { connectors, getConnector };
