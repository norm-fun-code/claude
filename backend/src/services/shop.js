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
const axios = require('axios');
const llm = require('../llm');
const { query: dbQuery } = require('../db');

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

/**
 * Use Claude to turn natural language into a structured search: a clean query
 * plus an optional price ceiling ("white running sneakers under $100" ->
 * { query: 'white running sneakers', maxPrice: 100 }).
 */
async function extractSearch(message) {
  const system =
    'Turn the shopping request into JSON: {"query": "<concise product search, brand+type, no filler>", ' +
    '"maxPrice": <number or null>}. Capture any price ceiling ("under $100", "below 50"). ' +
    'Reply with ONLY the JSON object.';
  try {
    const out = await llm.generateText({ system, prompt: message, temperature: 0, maxTokens: 80 });
    const i = out.indexOf('{'); const j = out.lastIndexOf('}');
    const parsed = i !== -1 ? JSON.parse(out.slice(i, j + 1)) : null;
    return {
      query: (parsed?.query || message).trim().replace(/^["']|["']$/g, ''),
      maxPrice: Number.isFinite(parsed?.maxPrice) ? Number(parsed.maxPrice) : null,
    };
  } catch {
    return { query: message, maxPrice: null };
  }
}

/** Back-compat: just the query string. */
async function extractQuery(message) {
  return (await extractSearch(message)).query;
}

/** Parse a price string/number like "$89.00" -> 89. */
function priceNum(p) {
  if (p == null) return null;
  const n = parseFloat(String(p).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Search the UCP global catalog for a product query. Returns top matches. */
async function searchCatalog(query, { country = 'US', limit = 12 } = {}) {
  const out = await run([
    'catalog', 'search',
    '--set', `/query=${query}`,
    '--set', `/context/address_country=${country}`,
    '--format', 'json',
  ]);
  const data = parseJson(out);
  const items = data?.results || data?.items || [];
  return items.slice(0, limit).map((r) => ({
    id: r.id || r.variant_id || r.item?.id,
    title: r.title || r.name || r.item?.title,
    price: r.price || r.item?.price || null,
    seller: r.seller_domain || r.business || r.merchant || null,
    buyUrl: r.buy_url || r.url || null,
    image: r.image || r.item?.image || null,
  })).filter((x) => x.id);
}

/**
 * Web product discovery via SerpApi (Google Shopping). Returns real products
 * with images, accurate prices, and seller — including Amazon. Discovery-only
 * (link-out). Preferred when SERPAPI_KEY is set; we fall back to Claude web
 * search otherwise.
 */
async function serpApiProducts(query, { maxPrice = null, limit = 8 } = {}) {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error('SERPAPI_KEY not set');
  const params = {
    engine: 'google_shopping',
    q: query,
    api_key: key,
    num: 20,
    gl: 'us',
    hl: 'en',
  };
  const { data } = await axios.get('https://serpapi.com/search', { params, timeout: 20000 });
  let items = (data.shopping_results || []).map((r) => ({
    id: r.product_link || r.link,
    title: r.title,
    price: r.price || (r.extracted_price != null ? `$${r.extracted_price}` : null),
    extractedPrice: r.extracted_price != null ? Number(r.extracted_price) : null,
    seller: r.source || null,
    url: r.product_link || r.link,
    image: r.thumbnail || null,
    web: true,
  })).filter((x) => x.title && x.url);

  if (maxPrice != null) items = items.filter((x) => x.extractedPrice == null || x.extractedPrice <= maxPrice);
  // Prefer recognizable, reorder-able retailers; cheapest-first within each tier.
  // This floats Amazon/Target/Walmart/etc. and the brand's own site above
  // obscure single-item listings, while still respecting price.
  const rank = (seller = '') => {
    const s = seller.toLowerCase();
    const major = ['amazon', 'target', 'walmart', 'costco', 'thrive', 'kroger', 'cvs', 'walgreens', 'whole foods', 'instacart', 'gopuff', 'iherb', 'vitacost'];
    if (major.some((m) => s.includes(m))) return 0;
    return 1; // everyone else
  };
  items.sort((a, b) => {
    const r = rank(a.seller) - rank(b.seller);
    if (r !== 0) return r;
    return (a.extractedPrice ?? 1e9) - (b.extractedPrice ?? 1e9);
  });
  return items.slice(0, limit);
}

/**
 * Web product discovery via Claude's web_search tool. Surfaces real products
 * across the open web — including Amazon, which isn't in UCP — as a list of
 * { title, price, seller, url } you tap to buy yourself. Discovery-only: no cart.
 */
async function webSearchProducts(query, { maxPrice = null, limit = 6 } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  const budget = maxPrice != null ? ` under $${maxPrice}` : '';
  const instruction =
    `Find specific products to buy online for: "${query}"${budget}. ` +
    `Search shopping sites including Amazon. Return ONLY a JSON array (no prose) of up to ${limit} ` +
    `items, each {"title","price","seller","url","image"} — url is the direct product page, ` +
    `price like "$12.99", seller like "Amazon" or the store name, and image is a direct URL to ` +
    `the product's photo (.jpg/.png/.webp). Prefer the cheapest in-stock options. ` +
    `Include the image URL whenever you can find one.`;

  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model,
      max_tokens: 1500,
      messages: [{ role: 'user', content: instruction }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 45000,
    }
  );

  // Concatenate text blocks, then extract the JSON array.
  const text = (data.content || []).map((b) => b.text || '').join('');
  const i = text.indexOf('['); const j = text.lastIndexOf(']');
  let items = [];
  if (i !== -1 && j !== -1) {
    try { items = JSON.parse(text.slice(i, j + 1)); } catch { items = []; }
  }
  return items
    .filter((x) => x && x.title && x.url)
    .map((x) => ({
      id: x.url, // url doubles as the id (no cart for web items)
      title: x.title,
      price: x.price || null,
      seller: x.seller || null,
      url: x.url,
      image: x.image || null,
      web: true, // flag: discovery-only, opens externally
    }))
    .slice(0, limit);
}

/** Build a cart on the chosen merchant; returns a continue_url for checkout. */
async function buildCart({ business, variantId, quantity = 1 }) {
  const out = await run([
    'cart', 'create',
    '--business', business,
    '--set', `/line_items/0/item/id=${variantId}`,
    '--set', `/line_items/0/quantity=${quantity}`,
    '--format', 'json',
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
 * Discovery: message -> search the catalog -> return a list of options to browse
 * (price-filtered if the user gave a ceiling). No cart yet — you pick one, then
 * call addToCart() for that item. This is the "surface ideas, then I choose" flow.
 */
async function discover(message, { country = 'US', limit = 8 } = {}) {
  if (!message || !message.trim()) throw new Error('Tell me what you’re looking for.');
  const { query, maxPrice } = await extractSearch(message);

  // Run both discovery modes in parallel:
  //  - UCP catalog: cart-able in-app (Shopify/Etsy/Target/…), no Amazon.
  //  - Web search: anything incl. Amazon, link-out only. Prefer SerpApi (images
  //    + accurate prices) when SERPAPI_KEY is set; else Claude web search.
  const webFinder = process.env.SERPAPI_KEY
    ? serpApiProducts(query, { maxPrice, limit: 8 }).catch(() => webSearchProducts(query, { maxPrice, limit: 6 }))
    : webSearchProducts(query, { maxPrice, limit: 6 });

  // UCP in-app carts are gated behind UCP_ENABLED — the ucp-cli can't run in the
  // Railway container (npx fetch fails), and trying it would add latency on every
  // search. Discovery via SerpApi covers those merchants as link-outs anyway.
  const ucpFinder = process.env.UCP_ENABLED === 'true'
    ? searchCatalog(query, { country, limit: 12 })
    : Promise.resolve([]);

  const [ucpRes, webRes] = await Promise.allSettled([ucpFinder, webFinder]);

  const ucp = ucpRes.status === 'fulfilled' ? ucpRes.value : [];
  const web = webRes.status === 'fulfilled' ? webRes.value : [];

  const underBudget = (r) => {
    if (maxPrice == null) return true;
    const p = priceNum(r.price);
    return p == null || p <= maxPrice;
  };

  // Cart-able UCP items first (you can buy in-app), then web/Amazon link-outs.
  const cartable = ucp.filter(underBudget).map((r) => ({ ...r, web: false }));
  const links = web.filter(underBudget);
  const results = [...cartable, ...links].slice(0, limit + 4);

  if (!results.length) {
    return {
      query, maxPrice, results: [], status: 'no_results',
      message: `No matches${maxPrice != null ? ` under $${maxPrice}` : ''} for "${query}".`,
    };
  }

  return {
    query, maxPrice,
    status: 'results',
    results,
    message:
      `Found ${results.length}${maxPrice != null ? ` under $${maxPrice}` : ''} for "${query}". ` +
      `${cartable.length ? 'Tap “Add to cart” to buy in-app, or' : 'Tap'} open a link to buy on the site.`,
  };
}

/** Build a cart for a specific chosen item, returning a checkout link. */
async function addToCart({ business, variantId, quantity = 1, item = null }) {
  if (!business || !variantId) throw new Error('Pick an item first.');
  try {
    const cart = await buildCart({ business, variantId, quantity });
    // Record to history (best-effort) so it shows up under "Reorder".
    if (item?.title) {
      recordOrder({ ...item, business, variantId }).catch(() => {});
    }
    return {
      status: cart.continueUrl ? 'cart_ready' : 'cart_partial',
      cart,
      message: cart.continueUrl
        ? 'Cart ready — tap to review and check out.'
        : 'Cart built; open the merchant to finish checkout.',
    };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/** Save (or refresh) an item in shop history for one-tap reorder. */
async function recordOrder(it) {
  await dbQuery(
    `INSERT INTO shop_orders (title, business, variant_id, price, query, image)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [it.title, it.business || null, it.variantId || it.id || null, it.price || null, it.query || null, it.image || null]
  );
}

/** Recent shop history (de-duped by title, newest first) for the Reorder list. */
async function history({ limit = 12 } = {}) {
  const { rows } = await dbQuery(
    `SELECT DISTINCT ON (title) id, title, business, variant_id, price, image, created_at
       FROM shop_orders
      ORDER BY title, created_at DESC`
  );
  return rows
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit)
    .map((r) => ({
      id: r.id, title: r.title, business: r.business, variantId: r.variant_id,
      price: r.price, image: r.image, lastOrdered: r.created_at,
    }));
}

/** Back-compat one-shot: discover then auto-build a cart on the top match. */
async function shop(message, { quantity = 1, country = 'US' } = {}) {
  const d = await discover(message, { country });
  if (d.status !== 'results') return d;
  const best = d.results.find((r) => r.seller) || d.results[0];
  const added = best.seller ? await addToCart({ business: best.seller, variantId: best.id, quantity }) : {};
  return { ...d, pick: best, cart: added.cart || null, status: added.cart?.continueUrl ? 'cart_ready' : 'results' };
}

/** Raw UCP catalog probe — returns stdout/error so we can diagnose on Railway. */
async function ucpProbe(query = 'protein bars') {
  try {
    const out = await run([
      'catalog', 'search',
      '--set', `/query=${query}`,
      '--set', '/context/address_country=US',
      '--format', 'json',
    ], { timeout: 40000 });
    return { ok: true, rawLength: out.length, sample: out.slice(0, 1200) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { discover, addToCart, shop, history, recordOrder, searchCatalog, buildCart, serpApiProducts, webSearchProducts, ucpProbe, extractQuery, extractSearch };
