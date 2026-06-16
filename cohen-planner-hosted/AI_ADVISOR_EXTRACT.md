# Cohen Financial Planner — AI Advisor Extract

This document contains all CSS, HTML, and JavaScript for the AI Advisor tab,
extracted from `public/index.html`. Intended for sharing with another Claude
Code chat to iterate on or rebuild the advisor in isolation.

---

## Design token dependencies (from `:root` in the full file)

The advisor uses these CSS variables — include them or substitute your own:

```css
:root {
  --bg: #f6f9fc;
  --s1: #ffffff;
  --s2: #fafbfc;
  --s3: #f0f4f8;
  --bd: #e6ebf1;
  --bd2: #d0d7de;
  --tx: #0a2540;
  --t2: #425466;
  --t3: #8898aa;
  --accent: #635bff;
  --accent-d: #4f48cc;
  --accent-soft: #eeecff;
  --g: #1a8754;
  --r: #cd3d64;
  --shadow-sm: 0 1px 2px rgba(50,71,92,.04);
  --shadow: 0 2px 5px rgba(50,71,92,.06), 0 1px 2px rgba(50,71,92,.04);
}
```

---

## CSS (advisor-specific classes)

```css
.adv{display:flex;flex-direction:column;height:calc(100vh - 220px);min-height:500px;background:var(--s1);border:1px solid var(--bd);border-radius:9px;overflow:hidden}
.adv-msgs{flex:1;overflow-y:auto;padding:18px 22px;display:flex;flex-direction:column;gap:14px}
.adv-msgs::-webkit-scrollbar{width:6px}.adv-msgs::-webkit-scrollbar-thumb{background:var(--bd2);border-radius:3px}
.adv-msg{display:flex;gap:10px;max-width:760px}
.adv-msg.user{flex-direction:row-reverse;align-self:flex-end;max-width:560px}
.adv-avatar{width:26px;height:26px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;font-family:'SF Mono',monospace}
.adv-avatar.ai{background:var(--accent);color:#fff}
.adv-avatar.user{background:var(--s3);color:var(--tx);border:1px solid var(--bd2)}
.adv-bubble{padding:10px 14px;border-radius:8px;font-size:12.5px;line-height:1.6;color:var(--tx)}
.adv-msg.user .adv-bubble{background:var(--accent-soft);border:1px solid rgba(99,91,255,.15);color:var(--tx)}
.adv-msg.ai .adv-bubble{background:var(--s1);border:1px solid var(--bd);box-shadow:var(--shadow-sm)}
.adv-bubble p{margin-bottom:8px}.adv-bubble p:last-child{margin-bottom:0}
.adv-bubble ul,.adv-bubble ol{margin:6px 0 6px 20px}.adv-bubble li{margin-bottom:3px}
.adv-bubble strong{color:var(--tx);font-weight:600}
.adv-bubble code{font-family:'SF Mono',monospace;background:var(--accent-soft);padding:1px 5px;border-radius:3px;font-size:11px;color:var(--accent)}
.adv-bubble pre{background:var(--bg);padding:8px 10px;border-radius:5px;overflow-x:auto;margin:6px 0;font-size:11px;border:1px solid var(--bd)}
.adv-bubble table{border-collapse:collapse;margin:8px 0;font-size:11px;width:100%}
.adv-bubble th,.adv-bubble td{padding:5px 9px;border-bottom:1px solid var(--bd);text-align:left}
.adv-bubble th{font-weight:700;font-size:9.5px;text-transform:uppercase;color:var(--t3);letter-spacing:.5px}
.adv-bubble h3{font-size:13px;font-weight:700;margin:10px 0 4px;color:var(--tx)}
.adv-bubble h4{font-size:12px;font-weight:600;margin:8px 0 3px;color:var(--t2)}
.adv-input-area{padding:12px 18px 14px;border-top:1px solid var(--bd);background:var(--s1)}
.adv-input-wrap{display:flex;gap:6px;align-items:flex-end;background:var(--s2);border:1px solid var(--bd2);border-radius:8px;padding:6px}
.adv-input-wrap:focus-within{border-color:var(--accent)}
.adv-input{flex:1;background:transparent;border:none;color:var(--tx);font-family:inherit;font-size:12.5px;resize:none;outline:none;padding:6px;min-height:20px;max-height:140px;line-height:1.5}
.adv-send{background:var(--accent);color:#fff;border:none;padding:6px 12px;border-radius:5px;cursor:pointer;font-weight:600;font-size:11.5px;font-family:inherit;height:32px}
.adv-send:hover{background:var(--accent-d)}.adv-send:disabled{background:var(--bd2);cursor:not-allowed}
.adv-thinking{display:flex;gap:3px;padding:3px 0}
.adv-thinking span{width:5px;height:5px;border-radius:50%;background:var(--t3);animation:advblink 1.4s infinite}
.adv-thinking span:nth-child(2){animation-delay:.2s}.adv-thinking span:nth-child(3){animation-delay:.4s}
@keyframes advblink{0%,80%,100%{opacity:.3}40%{opacity:1}}
.adv-welcome{padding:20px;text-align:center;color:var(--t2);font-size:13px;line-height:1.6}
.adv-welcome h3{color:var(--tx);font-size:16px;margin-bottom:8px;font-weight:700}
.adv-starters{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-top:14px;text-align:left;max-width:600px;margin-left:auto;margin-right:auto}
.adv-starter{padding:10px 12px;background:var(--s2);border:1px solid var(--bd);border-radius:6px;cursor:pointer;font-size:11.5px;color:var(--t2);line-height:1.4;transition:all .15s}
.adv-starter:hover{border-color:var(--accent);color:var(--tx)}
.adv-starter strong{display:block;color:var(--tx);font-size:12px;margin-bottom:2px}
.adv-toolbar{display:flex;gap:6px;padding:8px 18px;border-bottom:1px solid var(--bd);background:var(--s1);align-items:center}
.adv-toolbar .ctx-pill{background:var(--s2);border:1px solid var(--bd);padding:3px 8px;border-radius:4px;font-size:9.5px;color:var(--t2);font-family:'SF Mono',monospace}
.adv-toolbar .ctx-pill strong{color:var(--g)}
.adv-toolbar button{background:var(--s2);border:1px solid var(--bd);color:var(--t2);padding:4px 9px;border-radius:4px;cursor:pointer;font-size:10px;font-family:inherit;font-weight:500;margin-left:auto}
.adv-toolbar button:hover{border-color:var(--bd2);color:var(--tx)}
.adv-wrap{display:grid;grid-template-columns:240px 1fr;gap:0;height:calc(100vh - 220px);min-height:500px;border:1px solid var(--bd);border-radius:9px;overflow:hidden;background:var(--s1)}
.adv-rail{background:var(--s2);border-right:1px solid var(--bd);display:flex;flex-direction:column;overflow:hidden}
.adv-rail-hdr{padding:12px 14px;border-bottom:1px solid var(--bd);display:flex;justify-content:space-between;align-items:center;background:var(--s2)}
.adv-rail-hdr h4{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:1.1px;color:var(--t3);margin:0}
.adv-rail-new{background:var(--accent);color:#fff;border:none;padding:4px 10px;border-radius:5px;cursor:pointer;font-size:10.5px;font-weight:600;font-family:inherit;transition:background .12s}
.adv-rail-new:hover{background:var(--accent-d)}
.adv-rail-list{flex:1;overflow-y:auto;padding:8px}
.adv-rail-list::-webkit-scrollbar{width:5px}.adv-rail-list::-webkit-scrollbar-thumb{background:var(--bd2);border-radius:3px}
.adv-rail-item{padding:9px 11px;border-radius:6px;cursor:pointer;margin-bottom:3px;border:1px solid transparent;font-size:11.5px;color:var(--t2);position:relative;transition:all .12s}
.adv-rail-item:hover{background:var(--s1);border-color:var(--bd)}
.adv-rail-item.active{background:var(--s1);border-color:var(--accent)}
.adv-rail-title{font-weight:600;color:var(--tx);margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:22px;font-size:11.5px;line-height:1.3}
.adv-rail-meta{font-size:9.5px;color:var(--t3);font-family:'SF Mono',monospace;display:flex;justify-content:space-between}
.adv-rail-actions{position:absolute;top:6px;right:6px;display:none;gap:2px}
.adv-rail-item:hover .adv-rail-actions{display:flex}
.adv-rail-actions button{background:var(--s2);border:1px solid var(--bd);width:20px;height:20px;border-radius:3px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:10px;padding:0;color:var(--t2);transition:all .1s}
.adv-rail-actions button:hover{background:var(--s3);color:var(--tx)}
.adv-rail-actions button.del:hover{color:var(--r);border-color:var(--r)}
.adv-rail-empty{color:var(--t3);font-size:11px;text-align:center;padding:18px 8px;line-height:1.5}
.adv-rail-footer{padding:8px;border-top:1px solid var(--bd);display:flex;flex-direction:column;gap:4px}
.adv-rail-footer button{background:var(--s1);border:1px solid var(--bd);color:var(--t2);padding:6px 9px;border-radius:5px;cursor:pointer;font-size:10.5px;font-family:inherit;font-weight:500;text-align:left;transition:all .12s}
.adv-rail-footer button:hover{border-color:var(--bd2);color:var(--tx)}
.adv-main{display:flex;flex-direction:column;overflow:hidden;background:var(--s1)}
@media(max-width:900px){.adv-wrap{grid-template-columns:1fr}.adv-rail{display:none}}
```

---

## HTML (injected into `#chartArea` by `renderAdvisorTab()`)

```html
<!-- Toolbar: live context pill + export/import buttons -->
<div class="adv-toolbar">
  <span class="ctx-pill">Context: <strong>LIVE</strong> · 33yr plan · $6.8M @ 2058</span>
  <button onclick="advExportChats()">📥 Export</button>
  <button onclick="advImportChats()">📤 Import</button>
</div>

<!-- Two-panel layout: conversation rail (left) + chat area (right) -->
<div class="adv-wrap">

  <!-- Left rail: conversation list -->
  <div class="adv-rail">
    <div class="adv-rail-hdr">
      <h4>Conversations</h4>
      <button class="adv-rail-new" onclick="advNewChat()">+ New</button>
    </div>
    <div class="adv-rail-list" id="advRailList">
      <!-- Populated by advRenderRail() -->
      <!-- Each item looks like: -->
      <!--
      <div class="adv-rail-item active" onclick="advSwitchChat('id')">
        <div class="adv-rail-title">Stripe RSU timing question</div>
        <div class="adv-rail-meta">
          <span>4 msgs</span>
          <span>2h</span>
        </div>
        <div class="adv-rail-actions">
          <button onclick="event.stopPropagation();advRenameChat('id')" title="Rename">✎</button>
          <button class="del" onclick="event.stopPropagation();advDeleteChat('id')" title="Delete">×</button>
        </div>
      </div>
      -->
    </div>
  </div>

  <!-- Right: message area + input -->
  <div class="adv-main">
    <div class="adv-msgs" id="advMsgs">

      <!-- Empty state (shown when no messages) -->
      <div class="adv-welcome">
        <h3>Ask me anything about your plan</h3>
        <p>I have your live planner state — every slider, scenario, and projection.</p>
        <div class="adv-starters">
          <div class="adv-starter" onclick="advAsk('Given my current plan, what should I prioritize in the next 12 months?')">
            <strong>🎯 Top priority?</strong>Next 12 months
          </div>
          <div class="adv-starter" onclick="advAsk('Run a stress test - what if equity returns are only 4% instead of 6%?')">
            <strong>📉 Stress test returns</strong>4% vs 6% returns
          </div>
          <div class="adv-starter" onclick="advAsk('Should I sell some Stripe RSU now to reduce concentration risk, or wait for IPO?')">
            <strong>⚠️ Stripe concentration</strong>Sell now or wait?
          </div>
          <div class="adv-starter" onclick="advAsk('How would moving from a $2M to $1.7M home affect my plan? Be specific.')">
            <strong>🏠 Home tradeoff</strong>$2M vs $1.7M
          </div>
          <div class="adv-starter" onclick="advAsk('What\'s the single biggest risk I\'m underweighting in this plan?')">
            <strong>🔍 Blind spots</strong>What am I missing?
          </div>
          <div class="adv-starter" onclick="advAsk('Where should I deploy my next $25K of monthly savings - FXAIX, individual stocks, or cash?')">
            <strong>💰 Deploy $25K</strong>Where to invest
          </div>
        </div>
      </div>

      <!-- A rendered AI message bubble -->
      <!--
      <div class="adv-msg ai">
        <div class="adv-avatar ai">AI</div>
        <div class="adv-bubble">
          <p>Your current plan shows...</p>
        </div>
      </div>
      -->

      <!-- A rendered user message bubble -->
      <!--
      <div class="adv-msg user">
        <div class="adv-avatar user">N</div>
        <div class="adv-bubble">
          <p>What's my biggest risk?</p>
        </div>
      </div>
      -->

      <!-- Thinking / loading state -->
      <!--
      <div class="adv-msg ai">
        <div class="adv-avatar ai">AI</div>
        <div class="adv-bubble">
          <div class="adv-thinking"><span></span><span></span><span></span></div>
        </div>
      </div>
      -->

    </div>

    <!-- Input area -->
    <div class="adv-input-area">
      <div class="adv-input-wrap">
        <textarea
          class="adv-input"
          id="advInput"
          placeholder="Ask anything about your plan, portfolio, scenarios, taxes..."
          rows="1"
        ></textarea>
        <button class="adv-send" id="advSend" onclick="advSend()">Send</button>
      </div>
    </div>
  </div>

</div>
```

---

## JavaScript

### State

```js
let advisorChats = {};        // { [id]: { id, title, messages[], messageCount, createdAt, updatedAt } }
let advisorActiveChatId = null;
let advisorConversation = []; // mirrors advisorChats[active].messages, used for Anthropic payload
```

### Utilities

```js
function advUuid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }

function advEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function advRelTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return min + 'm';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h';
  const d = Math.floor(hr / 24);
  if (d < 7) return d + 'd';
  const w = Math.floor(d / 7);
  if (w < 4) return w + 'w';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
```

### Markdown renderer

```js
function advMarkdown(text) {
  let h = text;
  // Code blocks
  h = h.replace(/```([\s\S]*?)```/g, (m, c) => `<pre>${advEscape(c.trim())}</pre>`);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Tables
  h = h.replace(/\n((?:\|.+\|\n)+)/g, (m, tbl) => {
    const rows = tbl.trim().split('\n');
    if (rows.length < 2) return m;
    const hdr = rows[0].split('|').slice(1, -1).map(c => c.trim());
    const isSep = rows[1].match(/^[\s|:\-]+$/);
    const body = isSep ? rows.slice(2) : rows.slice(1);
    let t = '<table><thead><tr>' + hdr.map(x => `<th>${x}</th>`).join('') + '</tr></thead><tbody>';
    body.forEach(r => {
      const cells = r.split('|').slice(1, -1).map(c => c.trim());
      t += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
    });
    return '\n' + t + '</tbody></table>';
  });
  // Headings
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  // Bold
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Bullet lists
  h = h.replace(/(?:^|\n)((?:[\-\*] .+\n?)+)/g, (m, l) => {
    const items = l.trim().split('\n').map(x => x.replace(/^[\-\*] /, ''));
    return '\n<ul>' + items.map(i => `<li>${i}</li>`).join('') + '</ul>';
  });
  // Paragraphs
  h = h.split('\n\n').map(p => {
    p = p.trim();
    if (!p) return '';
    if (p.startsWith('<')) return p;
    return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
  }).join('\n');
  return h;
}
```

### System prompt builder (live context injected on every send)

```js
// Called with run(P) output and current P params.
// R = projection array [{yr, normG, nancyG, gross, tax, effRate, inc, liq, eq, nw, k401, ...}]
// P = current slider params object
function buildLiveContext(R, P) {
  const y26 = R[0];
  const y30 = R.find(r => r.yr === P.homePurchaseYear) || R[4];
  const peakTuition = R.reduce((a, b) => b.tu > a.tu ? b : a);
  const y58 = R[R.length - 1];
  const deficitYrs = R.filter(r => r.surp < 0).length;
  const totalDef = R.filter(r => r.surp < 0).reduce((a, b) => a + Math.abs(b.surp), 0);
  const worst = Math.min(...R.map(r => r.surp));
  const totTuit = R.reduce((a, b) => a + b.tu, 0);
  const totSold = R.reduce((a, b) => a + (b.sold || 0), 0);
  const totTaxSale = R.reduce((a, b) => a + (b.txS || 0), 0);
  const planSY = P.planStartYear || 2026;

  return `You are Norm Cohen's personal financial advisor, embedded inside his Cohen Financial Planner.
You can see his live planner state. Be direct, specific, and unhedged. He values honest analysis
over generic advice — push back when his thinking is off. Use specific numbers from his current plan.

═══ LIVE PLANNER STATE ═══

INCOME (${planSY} base year)
• Norm gross: ${fmt(y26.normG)} (cash + RSU stock)
• Nancy gross: ${fmt(y26.nancyG)} (W2 currently, solo practice ${P.nancyRampYear}+)
• Combined gross: ${fmt(y26.gross)}
• Effective tax rate: ${(y26.effRate * 100).toFixed(1)}% all-in (Fed + NYS + NYC + FICA)
• Net take-home: ${fmt(y26.inc)}
• Pre-tax deductions: 401k ${fmt(P.pretax401k)} + benefits ${fmt(P.pretaxBenefits)}

LIFECYCLE PROJECTIONS
• Starting liquid NW: ${fmt(P.startingLiquid)}
• Net worth at ${y58.yr}: ${fmt(y58.nw)} ($${(y58.nw / 1e6).toFixed(2)}M)
• 401k at ${y58.yr}: ${fmt(y58.k401)}
• Grand total at 65: ${fmt(y58.nw + y58.k401)}
• Deficit years over lifecycle: ${deficitYrs}
• Worst single year: ${fmt(worst)}
• Total cumulative deficit: ${fmt(totalDef)}
• Total stock sold to fund deficits: ${fmt(totSold)}
• Total tax on those sales: ${fmt(totTaxSale)} (at ${(P.capGainsTaxRate * 100).toFixed(1)}% all-in NYC cap gains)

HOME PURCHASE PLAN
• Target: ${fmt(P.homePrice)} (${P.downPctg}% down) in ${P.homePurchaseYear}
• Down payment: ${fmt(P.homePrice * P.downPctg / 100)}
• Mortgage: ${fmt(P.homePrice - P.homePrice * P.downPctg / 100)} @ ${P.mortgageRate}% (30yr)
• ${y30.yr} liquid after purchase: ${fmt(y30.liq)}

KIDS & TUITION
• ${P.numKids} kids, births: ${P.kid1Birth}, ${P.kid2Birth}${P.numKids >= 3 ? ', ' + P.kid3Birth : ''}
• Total lifecycle tuition: ${fmt(totTuit)}
${peakTuition.tu > 0 ? `• Peak tuition year (${peakTuition.yr}): ${fmt(peakTuition.tu)}` : ''}

NANCY SOLO PRACTICE
• Rate: $${P.nancyHourlyRate}/hr × ${P.nancyWeeksPerYear} wks
• Ramp ${P.nancyRampClients}→${P.nancyMaxClients} clients over ${P.nancyRampYears} years
• Max gross: ${fmt(P.nancyMaxClients * P.nancyHourlyRate * P.nancyWeeksPerYear)}
• Solo practice: ${P.nancySoloPractice ? 'YES — QBI + home office + overhead deductions' : 'No (W2)'}

PORTFOLIO
• Return assumption: ${(P.investReturn * 100).toFixed(1)}%/yr
• Cap gains rate (all-in NYC): ${(P.capGainsTaxRate * 100).toFixed(1)}%

═══ HOUSEHOLD CONTEXT ═══

• Norm: Stripe IR, NYC. W-2 with cash + RSUs.
• Nancy: Family therapist. Plans solo practice ~2030.
• Currently UES (Pavilion, 500 E 77th, 2-year lease through 2029)
• Planning Brooklyn move (Midwood, near Barkai)

CURRENT HOLDINGS
• Fidelity ~$509K: FXAIX $347K, MU $44K, MSFT $35K, GOOG $31K, TSM $30K, CRWV $13K, SPAXX $9K
• Coinbase ~$36K: SOL $15.5K, ETH $10.5K, LINK $10.3K (no BTC by choice)
• Stripe RSUs ~$555K (earmarked for Brooklyn down payment)
• Private investments ~$42K
• 401k ~${fmt(P.k401Start || 210000)} (starting balance)

INVESTING PRINCIPLES
• Core/satellite: ~65% FXAIX index, ~35% high-conviction names
• Stripe RSUs = down payment capital, NOT investable
• Wash sale rules don't apply to crypto (TLH freely)
• Pre-establish post-IPO diversification plan before liquidity arrives
• Skeptical of 10% historical return; uses 6% nominal in plan
• Active tax-loss harvesting on FXAIX lots

═══ HOW TO RESPOND ═══

• Be direct and unhedged. He hates sycophancy.
• Use specific live numbers (e.g. "your current ${fmt(y58.nw + y58.k401)} projection")
• Push back on flawed thinking.
• Tax/legal: give your professional take without excessive caveats.
• Market/macro: take a position, acknowledge uncertainty briefly.
• 2-4 paragraphs typically. Tables/bullets when helpful.
• Don't restate his situation — get to the answer.`;
}
```

### Render functions

```js
function renderAdvisorTab(R, P) {
  const ca = document.getElementById('chartArea');
  ca.innerHTML = `
    <div class="adv-toolbar">
      <span class="ctx-pill">Context: <strong>LIVE</strong> · ${R.length}yr plan · $${(R[R.length-1].nw/1e6).toFixed(1)}M @ ${R[R.length-1].yr}</span>
      <button onclick="advExportChats()">📥 Export</button>
      <button onclick="advImportChats()">📤 Import</button>
    </div>
    <div class="adv-wrap">
      <div class="adv-rail">
        <div class="adv-rail-hdr">
          <h4>Conversations</h4>
          <button class="adv-rail-new" onclick="advNewChat()">+ New</button>
        </div>
        <div class="adv-rail-list" id="advRailList"></div>
      </div>
      <div class="adv-main">
        <div class="adv-msgs" id="advMsgs"></div>
        <div class="adv-input-area">
          <div class="adv-input-wrap">
            <textarea class="adv-input" id="advInput"
              placeholder="Ask anything about your plan, portfolio, scenarios, taxes..."
              rows="1"></textarea>
            <button class="adv-send" id="advSend" onclick="advSend()">Send</button>
          </div>
        </div>
      </div>
    </div>`;
  const input = document.getElementById('advInput');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); advSend(); }
  });
  advRenderRail();
  advRenderMessages();
}

function advRenderMessages() {
  const msgs = document.getElementById('advMsgs');
  if (!msgs) return;
  if (advisorConversation.length === 0) {
    msgs.innerHTML = `<div class="adv-welcome">
      <h3>Ask me anything about your plan</h3>
      <p>I have your live planner state — every slider, scenario, and projection. Try one of these or ask your own:</p>
      <div class="adv-starters">
        <div class="adv-starter" onclick="advAsk('Given my current plan, what should I prioritize in the next 12 months?')"><strong>🎯 Top priority?</strong>Next 12 months</div>
        <div class="adv-starter" onclick="advAsk('Run a stress test - what if equity returns are only 4% instead of 6%?')"><strong>📉 Stress test returns</strong>4% vs 6% returns</div>
        <div class="adv-starter" onclick="advAsk('Should I sell some Stripe RSU now to reduce concentration risk, or wait for IPO?')"><strong>⚠️ Stripe concentration</strong>Sell now or wait?</div>
        <div class="adv-starter" onclick="advAsk('How would moving from a $2M to $1.7M home affect my plan? Be specific.')"><strong>🏠 Home tradeoff</strong>$2M vs $1.7M</div>
        <div class="adv-starter" onclick="advAsk('What\'s the single biggest risk I\'m underweighting in this plan?')"><strong>🔍 Blind spots</strong>What am I missing?</div>
        <div class="adv-starter" onclick="advAsk('Where should I deploy my next $25K of monthly savings - FXAIX, individual stocks, or cash?')"><strong>💰 Deploy $25K</strong>Where to invest</div>
      </div>
    </div>`;
    return;
  }
  msgs.innerHTML = '';
  advisorConversation.forEach(m =>
    advAddMessage(m.role === 'assistant' ? 'ai' : 'user', m.content, false, msgs)
  );
}

function advAddMessage(role, content, isThinking, container) {
  const msgs = container || document.getElementById('advMsgs');
  if (!msgs) return null;
  const w = msgs.querySelector('.adv-welcome');
  if (w) w.remove();
  const msg = document.createElement('div');
  msg.className = 'adv-msg ' + role;
  const avatar = document.createElement('div');
  avatar.className = 'adv-avatar ' + role;
  avatar.textContent = role === 'ai' ? 'AI' : 'N';
  const bubble = document.createElement('div');
  bubble.className = 'adv-bubble';
  if (isThinking) {
    bubble.innerHTML = '<div class="adv-thinking"><span></span><span></span><span></span></div>';
  } else {
    bubble.innerHTML = role === 'ai'
      ? advMarkdown(content)
      : `<p>${advEscape(content).replace(/\n/g, '<br>')}</p>`;
  }
  msg.appendChild(avatar);
  msg.appendChild(bubble);
  msgs.appendChild(msg);
  msgs.scrollTop = msgs.scrollHeight;
  return bubble;
}

function advAsk(q) {
  const input = document.getElementById('advInput');
  if (input) { input.value = q; advSend(); }
}

function advRenderRail() {
  const list = document.getElementById('advRailList');
  if (!list) return;
  const sorted = Object.values(advisorChats).sort((a, b) => b.updatedAt - a.updatedAt);
  if (sorted.length === 0) {
    list.innerHTML = `<div class="adv-rail-empty">No conversations yet.<br>Click "+ New" to start.</div>`;
    return;
  }
  list.innerHTML = sorted.map(c => {
    const rel = advRelTime(c.updatedAt);
    const cnt = c.messages.length || c.messageCount || 0;
    return `<div class="adv-rail-item ${c.id === advisorActiveChatId ? 'active' : ''}" onclick="advSwitchChat('${c.id}')">
      <div class="adv-rail-title">${advEscape(c.title)}</div>
      <div class="adv-rail-meta">
        <span>${cnt} msg${cnt === 1 ? '' : 's'}</span>
        <span>${rel}</span>
      </div>
      <div class="adv-rail-actions">
        <button onclick="event.stopPropagation();advRenameChat('${c.id}')" title="Rename">✎</button>
        <button class="del" onclick="event.stopPropagation();advDeleteChat('${c.id}')" title="Delete">×</button>
      </div>
    </div>`;
  }).join('');
}
```

### Chat management

```js
async function loadAdvisorState() {
  try {
    const res = await fetch('/api/chats');
    if (!res.ok) return;
    const chats = await res.json();
    advisorChats = {};
    chats.forEach(c => {
      advisorChats[c.id] = {
        id: c.id, title: c.title, messages: [],
        messageCount: parseInt(c.message_count) || 0,
        createdAt: new Date(c.created_at).getTime(),
        updatedAt: new Date(c.updated_at).getTime()
      };
    });
    if (chats.length > 0 && !advisorActiveChatId) {
      advisorActiveChatId = chats[0].id;
      await advLoadMessages(advisorActiveChatId);
    }
  } catch (e) { console.error('loadAdvisorState error:', e) }
}

async function advLoadMessages(id) {
  if (!id || !advisorChats[id]) return;
  try {
    const res = await fetch('/api/chats/' + id);
    if (res.ok) {
      const data = await res.json();
      advisorChats[id].messages = data.messages || [];
      if (id === advisorActiveChatId) advisorConversation = advisorChats[id].messages;
    }
  } catch (e) {}
}

async function advNewChat() {
  const id = advUuid();
  try {
    await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title: 'New conversation' })
    });
  } catch (e) {}
  const now = Date.now();
  advisorChats[id] = { id, title: 'New conversation', messages: [], messageCount: 0, createdAt: now, updatedAt: now };
  advisorActiveChatId = id;
  advisorConversation = [];
  advRenderRail();
  advRenderMessages();
  const input = document.getElementById('advInput');
  if (input) input.focus();
}

async function advSwitchChat(id) {
  if (!advisorChats[id]) return;
  advisorActiveChatId = id;
  if (!advisorChats[id].messages || advisorChats[id].messages.length === 0) {
    await advLoadMessages(id);
  }
  advisorConversation = advisorChats[id].messages || [];
  advRenderRail();
  advRenderMessages();
}

async function advRenameChat(id) {
  const c = advisorChats[id];
  if (!c) return;
  const t = prompt('Rename conversation:', c.title);
  if (t && t.trim()) {
    c.title = t.trim().slice(0, 80);
    c.updatedAt = Date.now();
    fetch('/api/chats/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: c.title })
    }).catch(() => {});
    advRenderRail();
  }
}

async function advDeleteChat(id) {
  const c = advisorChats[id];
  if (!c) return;
  if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
  fetch('/api/chats/' + id, { method: 'DELETE' }).catch(() => {});
  delete advisorChats[id];
  if (advisorActiveChatId === id) {
    advisorActiveChatId = null;
    advisorConversation = [];
    advRenderMessages();
  }
  advRenderRail();
}
```

### Import / Export

```js
function advImportChats() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'application/json,.json';
  input.onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.chats || typeof data.chats !== 'object') throw new Error('Invalid file format');
        const incoming = Object.values(data.chats);
        if (!confirm(`Import ${incoming.length} conversation${incoming.length === 1 ? '' : 's'}? Merges with existing chats.`)) return;
        let imported = 0;
        const promises = [];
        Object.entries(data.chats).forEach(([id, chat]) => {
          if (chat.id && chat.messages && Array.isArray(chat.messages)) {
            const newId = advisorChats[id] ? advUuid() : id;
            advisorChats[newId] = { ...chat, id: newId, messages: chat.messages, messageCount: chat.messages.length, createdAt: chat.createdAt || Date.now(), updatedAt: chat.updatedAt || Date.now() };
            promises.push(
              fetch('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: newId, title: chat.title || 'Imported chat' }) })
                .then(() => fetch('/api/chats/' + newId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: chat.messages }) }))
                .catch(() => {})
            );
            imported++;
          }
        });
        Promise.all(promises).then(() => { advRenderRail(); alert(`Imported ${imported} conversation${imported === 1 ? '' : 's'}.`); });
      } catch (err) { alert('Failed to import: ' + err.message) }
    };
    reader.readAsText(file);
  };
  input.click();
}

function advExportChats() {
  const data = { exportedAt: new Date().toISOString(), chats: advisorChats };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `advisor-chats-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}
```

### Send (main message loop)

```js
async function advSend() {
  const input = document.getElementById('advInput');
  const text = input.value.trim();
  if (!text) return;
  if (!advisorActiveChatId || !advisorChats[advisorActiveChatId]) {
    await advNewChat();
    if (!advisorActiveChatId) return;
  }
  input.value = ''; input.style.height = 'auto';
  document.getElementById('advSend').disabled = true;

  // Optimistically render user message + thinking indicator
  advAddMessage('user', text);
  advisorConversation.push({ role: 'user', content: text });
  const chat = advisorChats[advisorActiveChatId];
  chat.messages = advisorConversation;
  if (chat.messages.length === 1) { chat.title = text.slice(0, 50) + (text.length > 50 ? '…' : ''); }
  chat.updatedAt = Date.now();
  advRenderRail();

  const thinking = advAddMessage('ai', '', true);

  // Build live context from current plan state and send to server
  const { R } = run(P);
  const liveContext = buildLiveContext(R, P);

  try {
    const res = await fetch('/api/advisor/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: advisorActiveChatId,
        message: text,
        systemPrompt: liveContext,
        messages: advisorConversation   // full history for multi-turn context
      })
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const answer = data.reply || 'Sorry, no response. Try again?';
    thinking.innerHTML = advMarkdown(answer);
    advisorConversation.push({ role: 'assistant', content: answer });
    chat.messages = advisorConversation;
    chat.updatedAt = Date.now();
    advRenderRail();
  } catch (err) {
    thinking.innerHTML = `<p style="color:var(--r)"><strong>Error:</strong> ${err.message}</p>
      <p style="font-size:11px;color:var(--t3);margin-top:4px">Check your connection and try again.</p>`;
    // Roll back the user message from in-memory state (DB was never written — atomic pair design)
    advisorConversation.pop();
    chat.messages = advisorConversation;
  } finally {
    document.getElementById('advSend').disabled = false;
    input.focus();
  }
}
```

---

## Server-side API routes (Node.js / Express)

```js
// GET  /api/chats          — list all chats (id, title, message_count, timestamps)
// GET  /api/chats/:id      — full chat with messages array
// POST /api/chats          — create chat { id, title }
// PUT  /api/chats/:id      — update { title?, messages? }
// DELETE /api/chats/:id    — delete chat

// POST /api/advisor/message  — proxy to Anthropic
//   body: { chatId, message, systemPrompt, messages }
//   Calls claude-sonnet-4-6, max_tokens: 4000
//   Persists user+assistant pair atomically AFTER successful response
//   Returns: { reply, usage }
```

### Anthropic proxy (server.js)

```js
app.post('/api/advisor/message', requireAuth, async (req, res) => {
  const { chatId, message, systemPrompt, messages } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId and message required' });
  try {
    // Call Anthropic first — only persist to DB if it succeeds (prevents orphaned messages)
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: systemPrompt,
      messages: messages,
    });
    const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

    // Persist user + assistant together as atomic pair
    const pair = [
      { role: 'user', content: message },
      { role: 'assistant', content: reply },
    ];
    await db.query(
      `UPDATE advisor_chats SET messages = messages || $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(pair), chatId]
    );

    // Set title on first exchange
    const countRes = await db.query(
      `SELECT jsonb_array_length(messages) AS cnt FROM advisor_chats WHERE id = $1`, [chatId]
    );
    if ((countRes.rows[0]?.cnt || 0) <= 2) {
      const title = message.slice(0, 60) + (message.length > 60 ? '…' : '');
      await db.query('UPDATE advisor_chats SET title=$1 WHERE id=$2', [title, chatId]);
    }

    res.json({ reply, usage: response.usage });
  } catch (err) {
    console.error('Advisor message error:', err);
    res.status(500).json({ error: (err.message || 'Anthropic API error').slice(0, 200) });
  }
});
```

---

## Database schema (PostgreSQL)

```sql
CREATE TABLE IF NOT EXISTS advisor_chats (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  messages   JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Key design decisions

| Decision | Rationale |
|---|---|
| Atomic user+assistant persistence | Prevents orphaned user messages when Anthropic call fails |
| System prompt rebuilt on every send | Always reflects the user's current slider state, not state at chat creation |
| `messages` array sent to Anthropic | Full conversation history passed each time for multi-turn context |
| Conversations stored in Postgres | Cross-device sync; survives browser refresh |
| `max_tokens: 4000` | Allows detailed multi-paragraph responses with tables |
| Model: `claude-sonnet-4-6` | Fast enough for chat UX; sufficient for financial Q&A; Opus adds latency without meaningful quality gain for this use case |
