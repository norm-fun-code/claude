// Shopping agent (UCP). Turns a natural-language request ("reorder Aloha bars")
// into a built cart you can check out yourself — the "build cart, you pay" model
// from Google's Universal Commerce Protocol. We never autonomously pay; the agent
// searches the UCP global catalog, builds a cart on the merchant, and hands back
// a `continue_url` you tap to complete checkout (Google Pay / merchant site).
//
// Mechanics: shells out to Shopify's `@shopify/ucp-cli` (the reference UCP agent
// skill). catalog search is cross-merchant (no URL needed); cart create returns a
// continue_url. Claude extracts the product query from your phrasing.
//
// Requirements to go fully live:
//   - npx can reach @shopify/ucp-cli (bundled at deploy, or installed)
//   - UCP_CATALOG_JWT (Shopify Developer Dashboard) for Shopify checkout handoff
// Without these it runs in a safe "preview" mode and explains what's missing.
const { execFile } = require('child_process');
const llm = require('../llm');

const UCP = ['@shopify/ucp-cli'];
const TIMEOUT = 25000;

function run(args, { timeout = TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    execFile('npx', ['--yes', ...UCP, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(0, 400)));
      resolve(stdout);
    });
  });
}

function parseJson(out) {
  // ucp-cli prints structured JSON with --view json; be tolerant of prose around it.
  const i = out.indexOf('{');
  const j = out.lastIndexOf('}');
  if (i === -1 || j === -1) return null;
  try { return JSON.parse(out.slice(i, j + 1)); } catch { return null; }
}

/** Use Claude to pull a clean product search query from natural language. */
async function extractQuery(message) {
  const system =
    'Extract the product the user wants to buy as a concise search query (brand + product, ' +
    'no filler). Reply with ONLY the query text, nothing else.';
  try {
    const q = await llm.generateText({ system, prompt: message, temperature: 0, maxTokens: 40 });
    return (q || message).trim().replace(/^["']|["']$/g, '');
  } catch {
    return message;
  }
}

/** Search the UCP global catalog for a product query. Returns top matches. */
async function searchCatalog(query, { country = 'US' } = {}) {
  const out = await run([
    'catalog', 'search',
    '--set', `/query=${query}`,
    '--set', `/context/address_country=${country}`,
    '--view', 'json',
  ]);
  const data = parseJson(out);
  const items = data?.results || data?.items || [];
  return items.slice(0, 5).map((r) => ({
    id: r.id || r.variant_id || r.item?.id,
    title: r.title || r.name || r.item?.title,
    price: r.price || r.item?.price || null,
    seller: r.seller_domain || r.business || r.merchant || null,
    buyUrl: r.buy_url || r.url || null,
    image: r.image || r.item?.image || null,
  })).filter((x) => x.id);
}

/** Build a cart on the chosen merchant; returns a continue_url for checkout. */
async function buildCart({ business, variantId, quantity = 1 }) {
  const out = await run([
    'cart', 'create',
    '--business', business,
    '--set', `/line_items/0/item/id=${variantId}`,
    '--set', `/line_items/0/quantity=${quantity}`,
    '--view', 'json',
  ]);
  const data = parseJson(out);
  return {
    cartId: data?.id || data?.cart_id || null,
    continueUrl: data?.continue_url || data?.checkout_url || null,
    total: data?.total || data?.estimated_total || null,
    shipping: data?.shipping || null,
    raw: data || null,
  };
}

/**
 * Full flow: message -> query -> search -> build cart on best match -> return the
 * cart + a checkout link you tap yourself. `dryRun` stops after search (no cart).
 */
async function shop(message, { quantity = 1, country = 'US' } = {}) {
  if (!message || !message.trim()) throw new Error('Tell me what to order.');
  const query = await extractQuery(message);

  let results;
  try {
    results = await searchCatalog(query, { country });
  } catch (err) {
    // UCP CLI not reachable / not configured — return a clear, non-fake state.
    return {
      query,
      status: 'unavailable',
      message:
        'Shopping agent is set up but not yet connected to a live UCP catalog. ' +
        'Add UCP access (and UCP_CATALOG_JWT for Shopify checkout) to enable real carts.',
      detail: err.message,
      results: [],
    };
  }

  if (!results.length) {
    return { query, status: 'no_results', results: [], message: `No matches for "${query}".` };
  }

  // Best match = first result with a seller we can build a cart on.
  const best = results.find((r) => r.seller) || results[0];
  let cart = null;
  if (best.seller) {
    try {
      cart = await buildCart({ business: best.seller, variantId: best.id, quantity });
    } catch (err) {
      cart = { error: err.message };
    }
  }

  return {
    query,
    status: cart?.continueUrl ? 'cart_ready' : 'found',
    pick: best,
    results,
    cart,
    message: cart?.continueUrl
      ? `Built a cart for ${best.title}. Tap to review and check out.`
      : `Found ${best.title}. Open it to add to cart and check out.`,
  };
}

module.exports = { shop, searchCatalog, buildCart, extractQuery };
