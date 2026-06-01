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
const SEARCH_URL = process.env.UCP_SEARCH_URL || 'https://discover.shopifyapps.com/global/v2/search';

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

/** Cross-merchant product search (global catalog) via the REST discover API. */
async function searchCatalog(query, { country = 'US', limit = 12 } = {}) {
  if (!isConfigured()) return [];
  const token = await getToken();
  const { data } = await axios.get(SEARCH_URL, {
    params: { q: query, query, limit, country },
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 25000,
  });
  // Response shape TBD from a live call — handle the common envelopes.
  const results = data?.results || data?.products || data?.data || (Array.isArray(data) ? data : []);
  const out = [];
  for (const r of results) {
    // Results may cluster by UPID with offers from multiple merchants.
    const offers = r.offers || (r.offer ? [r.offer] : [r]);
    for (const off of offers) {
      const seller = off.seller?.domain || off.seller?.name || off.shop_domain || r.seller?.domain || r.shop_domain || null;
      out.push({
        id: off.variant_id || off.variantId || off.offer_id || off.id || r.id || r.upid,
        upid: r.upid || r.universal_product_id || r.id || null,
        title: r.title || r.name || off.title,
        price: off.price || r.price || null,
        extractedPrice: priceNum(off.price || r.price),
        seller,
        business: seller, // merchant domain, for cart create
        url: off.buy_url || off.online_store_url || off.url || r.url || null,
        image: r.image || r.featured_image || r.images?.[0] || off.image || null,
        web: false, // UCP item — cart-able in-app
      });
    }
  }
  return out.filter((x) => x.title && x.id).slice(0, limit);
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
