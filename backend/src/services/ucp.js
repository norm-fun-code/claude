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

// Real Shopify endpoints (from the Dev Dashboard request sample):
//   token:  POST https://api.shopify.com/auth/access_token  (client_credentials)
//   search: GET  https://discover.shopifyapps.com/global/v2/... (Bearer token)
const TOKEN_URL = process.env.UCP_TOKEN_URL || 'https://api.shopify.com/auth/access_token';
// Global Catalog MCP (JSON-RPC) — from the Dev Dashboard sample:
//   POST https://discover.shopifyapps.com/global/mcp
//   tools/call -> search_global_products { query, context, limit, saved_catalog }
const MCP_URL = process.env.UCP_MCP_URL || 'https://discover.shopifyapps.com/global/mcp';
const CATALOG_ID = process.env.UCP_CATALOG_ID || '';

function publicBase() {
  // The HTTPS origin Railway serves us on — where our agent profile lives.
  return (process.env.PUBLIC_URL || 'https://backend-production-0902.up.railway.app').replace(/\/$/, '');
}
function agentProfileUrl() {
  return `${publicBase()}/.well-known/ucp-agent`;
}

function isConfigured() {
  return !!(process.env.UCP_CLIENT_ID && process.env.UCP_CLIENT_SECRET && (process.env.UCP_CATALOG_ID || CATALOG_ID));
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

let _rpcId = 0;

/** Cross-merchant product search (global catalog) via the Global Catalog MCP. */
async function searchCatalog(query, { country = 'US', limit = 12 } = {}) {
  if (!isConfigured()) return [];
  const token = await getToken();
  const catalogId = process.env.UCP_CATALOG_ID || CATALOG_ID;
  const { data } = await axios.post(
    MCP_URL,
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: ++_rpcId,
      params: {
        name: 'search_global_products',
        arguments: { query, context: '', limit, saved_catalog: catalogId },
      },
    },
    {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      timeout: 25000,
    }
  );
  if (data.error) throw new Error('UCP MCP error: ' + JSON.stringify(data.error).slice(0, 300));
  // MCP tool result: result.content[] blocks (text or json). Extract the payload.
  let payload = data.result?.structuredContent || data.result;
  const blocks = data.result?.content || [];
  for (const b of blocks) {
    if (b.type === 'json' && b.json) { payload = b.json; break; }
    if (b.type === 'text' && b.text) { try { payload = JSON.parse(b.text); break; } catch { /* keep */ } }
  }
  const results = payload?.results || payload?.products || payload?.data || (Array.isArray(payload) ? payload : []);

  // Money helper: Shopify amounts are in cents (3899 -> $38.99).
  const money = (m) => {
    if (!m || m.amount == null) return { str: null, num: null };
    const num = Number(m.amount) / 100;
    return { str: `$${num.toFixed(2)}`, num };
  };

  const out = [];
  for (const r of results) {
    // Each product has variants; each variant carries its own shop + buy url.
    // Use the first variant for the headline offer (cheapest pack the search hit).
    const v = (r.variants && r.variants[0]) || {};
    const p = money(v.price || r.priceRange?.min);
    const shopName = v.shop?.name || r.shop?.name || null;
    const shopUrl = v.shop?.onlineStoreUrl || r.shop?.onlineStoreUrl || null;
    out.push({
      id: v.id || r.id, // variant gid (for future cart) or product gid
      upid: r.id || null,
      title: r.title || v.displayName,
      price: p.str,
      extractedPrice: p.num,
      seller: shopName,
      business: shopUrl, // merchant storefront (for cart create later)
      url: v.variantUrl || shopUrl || r.lookupUrl || null,
      image: r.media?.[0]?.url || v.media?.[0]?.url || null,
      rating: r.rating?.rating || null,
      // Treated as link-out for now (open variantUrl). In-app cart-building is a
      // separate per-merchant UCP step, wired next; flip to false then.
      web: true,
      ucp: true, // tag: high-quality Shopify catalog result
    });
  }
  return out.filter((x) => x.title && x.url).slice(0, limit);
}

/** Build a cart on a specific merchant; returns a continue_url for checkout.
 *  The discover REST API is search-only — cart building is a per-merchant UCP
 *  step we wire once search is proven. For now, no in-app cart endpoint, so the
 *  shop layer falls back to opening the product URL. */
async function createCart() {
  return { cartId: null, continueUrl: null, total: null, raw: null };
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
