// UCP (Universal Commerce Protocol) client — talks to Shopify's Global Catalog
// MCP server directly over HTTP (JSON-RPC 2.0), so no `ucp-cli`/npx (which can't
// run in Railway's container). This unlocks cross-merchant product search WITH
// images and in-app cart building for Shopify merchants.
//
// Flow:
//   1. We host a UCP *agent profile* at {PUBLIC_URL}/.well-known/ucp-agent
//      (see server.js) declaring our capabilities. Every MCP request references
//      it via meta["ucp-agent"].profile so the catalog can negotiate.
//   2. Exchange Shopify client credentials (UCP_CLIENT_ID/SECRET from the
//      Shopify Dev Dashboard → Catalogs) for a JWT (60-min TTL; cached here).
//   3. Call search_catalog / get_product / cart tools via JSON-RPC.
//
// Dormant until UCP_CLIENT_ID + UCP_CLIENT_SECRET are set.
const axios = require('axios');

const MCP_URL = process.env.UCP_MCP_URL || 'https://catalog.shopify.com/api/ucp/mcp';
const TOKEN_URL = process.env.UCP_TOKEN_URL || 'https://catalog.shopify.com/api/ucp/oauth/token';

function publicBase() {
  // The HTTPS origin Railway serves us on — where our agent profile lives.
  return (process.env.PUBLIC_URL || 'https://backend-production-0902.up.railway.app').replace(/\/$/, '');
}
function agentProfileUrl() {
  return `${publicBase()}/.well-known/ucp-agent`;
}

function isConfigured() {
  return !!(process.env.UCP_CLIENT_ID && process.env.UCP_CLIENT_SECRET);
}

// --- token cache ------------------------------------------------------------
let _token = null;
let _tokenExp = 0;

async function getToken() {
  const now = Date.now();
  if (_token && now < _tokenExp - 60000) return _token; // reuse until ~1min before expiry
  const { data } = await axios.post(
    TOKEN_URL,
    {
      grant_type: 'client_credentials',
      client_id: process.env.UCP_CLIENT_ID,
      client_secret: process.env.UCP_CLIENT_SECRET,
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  _token = data.access_token || data.token;
  const ttl = (data.expires_in ? Number(data.expires_in) : 3600) * 1000;
  _tokenExp = now + ttl;
  if (!_token) throw new Error('UCP token exchange returned no token');
  return _token;
}

// --- JSON-RPC over MCP ------------------------------------------------------
let _rpcId = 0;
async function mcpCall(method, params = {}) {
  const token = await getToken();
  const body = {
    jsonrpc: '2.0',
    id: ++_rpcId,
    method,
    params: {
      ...params,
      _meta: { 'ucp-agent': { profile: agentProfileUrl() } },
    },
  };
  const { data } = await axios.post(MCP_URL, body, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    timeout: 25000,
  });
  if (data.error) throw new Error('UCP MCP error: ' + JSON.stringify(data.error).slice(0, 300));
  return data.result;
}

// MCP "tools/call" wrapper — tools are invoked by name with an arguments object.
async function callTool(name, args = {}) {
  const result = await mcpCall('tools/call', { name, arguments: args });
  // MCP tool results come back as content blocks; pull the JSON/text payload.
  const blocks = result?.content || [];
  for (const b of blocks) {
    if (b.type === 'json' && b.json) return b.json;
    if (b.type === 'text' && b.text) {
      try { return JSON.parse(b.text); } catch { /* not json */ }
    }
  }
  return result?.structuredContent || result;
}

/** Cross-merchant product search (global catalog). Returns normalized items. */
async function searchCatalog(query, { country = 'US', limit = 12 } = {}) {
  if (!isConfigured()) return [];
  const data = await callTool('search_catalog', {
    query,
    context: { address_country: country },
  });
  const results = data?.results || data?.products || [];
  const out = [];
  for (const r of results) {
    // Results cluster by UPID with offers from multiple merchants.
    const offers = r.offers || (r.offer ? [r.offer] : [{}]);
    for (const off of offers) {
      out.push({
        id: off.variant_id || off.offer_id || r.id || r.upid,
        upid: r.upid || r.id || null,
        title: r.title || r.name,
        price: off.price || r.price || null,
        extractedPrice: priceNum(off.price || r.price),
        seller: off.seller?.domain || off.seller?.name || r.seller?.domain || null,
        business: off.seller?.domain || r.seller?.domain || null, // for cart create
        url: off.buy_url || off.url || r.url || null,
        image: r.image || r.images?.[0] || off.image || null,
        web: false, // UCP item — cart-able in-app
      });
    }
  }
  return out.slice(0, limit);
}

/** Build a cart on a specific merchant; returns a continue_url for checkout. */
async function createCart({ business, variantId, quantity = 1 }) {
  if (!isConfigured()) throw new Error('UCP not configured');
  const data = await callTool('create_cart', {
    business,
    line_items: [{ item: { id: variantId }, quantity }],
  });
  return {
    cartId: data?.id || data?.cart_id || null,
    continueUrl: data?.continue_url || data?.checkout_url || null,
    total: data?.total || data?.estimated_total || null,
    raw: data || null,
  };
}

function priceNum(p) {
  if (p == null) return null;
  if (typeof p === 'number') return p;
  if (typeof p === 'object' && p.amount != null) return Number(p.amount);
  const n = parseFloat(String(p).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// The agent profile JSON we host. Declares the capabilities we use so the
// catalog can negotiate versions with us.
function agentProfile() {
  return {
    'ucp.version': '2026-04-08',
    agent: { name: 'NormOS', description: "Norman's personal shopping agent" },
    capabilities: {
      'dev.ucp.shopping.catalog.search': [{ version: '2026-04-08' }],
      'dev.ucp.shopping.cart': [{ version: '2026-04-08' }],
      'dev.ucp.shopping.checkout': [{ version: '2026-04-08' }],
    },
  };
}

module.exports = { isConfigured, searchCatalog, createCart, agentProfile, agentProfileUrl, getToken };
