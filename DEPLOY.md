# NormOS Deploy Checklist

Steps to deploy the backend (Railway) and ship the mobile app (TestFlight).
Everything is committed to `main`. Run these from your Mac.

> **TL;DR once the one-time automation below is set up:**
> - **Backend change** → just push to `main`; Railway auto-deploys. Nothing to run.
> - **Mobile JS/TS change** (cards, layout, logic) → `cd mobile && eas update --branch production -m "what changed"`. Live in seconds, **no rebuild**.
> - **Mobile native change** (new native module, permissions, icon/splash, SDK
>   bump, or an app `version` bump) → full `eas build` + `eas submit` (rare).

---

## ⚡ One-time automation setup (do this once)

### A. Backend auto-deploy from GitHub (no more `railway up`)
In the **Railway dashboard** → your backend service → **Settings → Source**:
1. Connect the GitHub repo `norm-fun-code/claude`.
2. Set the branch to `main` and the root directory to `backend`.
3. Enable "auto-deploy on push".

After this, every push to `main` redeploys the backend automatically and runs
DB migrations on boot. (You can still `railway up` manually if ever needed.)

### B. Mobile OTA updates (EAS Update — skip the rebuild for JS changes)
The repo is already configured for OTA: `expo-updates` is in `package.json`,
`runtimeVersion` is `appVersion` in `app.json`, and each build profile has a
`channel` in `eas.json`. To finish linking (one-time, on your Mac):

```bash
cd ~/claude/mobile
npm install                      # pulls in expo-updates
npx eas-cli login                # if not already
npx eas-cli update:configure     # writes updates.url + the EAS projectId into app.json
```

Commit the `app.json` changes that `update:configure` makes:

```bash
git add app.json && git commit -m "Link EAS Update" && git push
```

> **Important:** Installing `expo-updates` is a NATIVE change, so it needs **one**
> full rebuild (step 5 below) to take effect. After that one build, all future
> JS/TS changes ship instantly via `eas update` — no rebuild.

---

## 1. Pull the code

```bash
cd ~/claude
git stash; git pull --no-rebase --no-edit origin main; git stash pop
```

## 2. Environment variables (one-time, on Railway)

**Required for the 8am morning-briefing + push feature:**

```bash
railway variables --service backend --set 'ENABLE_SCHEDULER=true'
railway variables --service backend --set 'TZ=America/New_York'
railway variables --service backend --set 'SCHEDULE_HOUR=8'
```

**UCP (Shopify Global Catalog) — verify they're set; add if missing:**

```bash
railway variables --service backend --kv 2>/dev/null | grep UCP_
# If missing (secret ends 2836):
# railway variables --service backend --set 'UCP_CLIENT_ID=54bb23ee62c5f181dfdaf4f5c6d1a4ab'
# railway variables --service backend --set 'UCP_CATALOG_ID=01kt0b6qer0n6gszm4r8r6xbpw'
# railway variables --service backend --set 'UCP_CLIENT_SECRET=YOUR_SECRET'
```

**Optional (sensible defaults exist; only set to override):**

- `CORS_ORIGINS` — comma-separated browser origins. Locks CORS in production.
  The mobile app isn't subject to CORS, so you only need this if you use a
  browser client. Leave unset = open (dev-friendly).
- `BRIEFING_SOURCE_TIMEOUT_MS` (default 12000) — per-source timeout in the briefing.
- `BRIEFING_LLM_TIMEOUT_MS` (default 40000) — LLM timeout in the briefing.
- `BRIEFING_CACHE_MIN` (default 180) — briefing cache TTL in minutes.
- `SERPAPI_KEY` — enables SerpApi web product search (images + accurate prices).
- `NORMOS_API_TOKEN` — bearer token gating /api. **Strongly recommended in
  production** (the server logs a loud warning at boot if it's unset).

## 3. Deploy backend (auto-runs DB migrations)

```bash
cd ~/claude/backend && railway up --service backend --detach
```

The `start` script runs `node src/db/migrate.js` before boot, applying any new
migrations automatically — no manual DB step. Wait ~45s for the container to
restart before testing.

## 4. Smoke-test the backend

```bash
NT=$(railway variables --service backend --kv 2>/dev/null | grep '^NORMOS_API_TOKEN=' | cut -d= -f2-)
B=https://backend-production-0902.up.railway.app

# New endpoints exist (no 404/500):
curl -s "$B/api/intentions/current" -H "Authorization: Bearer $NT"
curl -s "$B/api/highlights?limit=3" -H "Authorization: Bearer $NT" \
  | python3 -c "import sys,json;print('highlights:',len(json.load(sys.stdin)['highlights']))"
curl -s "$B/api/workout/checks?date=2026-06-01" -H "Authorization: Bearer $NT"

# UCP catalog working (expect pool ~24, an ALOHA seller, clean $38.99 prices):
curl -s -X POST "$B/api/shop/discover" -H "Authorization: Bearer $NT" \
  -H "Content-Type: application/json" -d '{"message":"aloha bars"}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('pool:',len(d['results']),'pageSize:',d.get('pageSize'))"

# Morning briefing build (dry run — builds the cache, no push):
curl -s -X POST "$B/api/morning/run" -H "Authorization: Bearer $NT" \
  -H "Content-Type: application/json" -d '{"dryRun":true}'
```

If UCP returns only web rows (no ALOHA seller), the catalog isn't matching —
use the diagnostic to see why:

```bash
curl -s "$B/api/shop/ucp-diagnose" -H "Authorization: Bearer $NT" | python3 -m json.tool
```

## 5. Build + ship the mobile app (TestFlight)

This is the **full rebuild** — needed the first time, after the `expo-updates`
install, and thereafter only for native changes / app `version` bumps.

```bash
cd ~/claude/mobile
npx eas-cli build --platform ios --profile production
npx eas-cli submit --platform ios --latest
```

(If `eas` isn't a global command, the `npx eas-cli ...` form above works without
installing. Run `npx eas-cli login` first if prompted.)

---

## 🔁 Ongoing workflow (after the one-time setup)

Most changes do **not** need a rebuild:

| Change type | What to run | Rebuild? |
|---|---|---|
| Backend (insights, API, briefing, push logic) | nothing — push to `main`, Railway auto-deploys | No |
| Mobile JS/TS (cards, layout, logic, copy) | `cd mobile && npx eas-cli update --branch production -m "msg"` | **No** — live in seconds |
| New native module / permission / icon / splash | full `eas build` + `eas submit` (step 5) | Yes |
| Expo SDK bump or app `version` bump | full `eas build` + `eas submit` | Yes |

**Push a mobile JS update (the common case):**

```bash
cd ~/claude/mobile
npx eas-cli update --branch production --message "what changed"
```

The installed app downloads it on next launch — no TestFlight, no review.

> Why `version` bumps need a rebuild: `runtimeVersion` is set to the `appVersion`
> policy, so an OTA update only lands on builds with a matching native version.
> Bumping `app.json` `version` (e.g. 1.0.0 → 1.1.0) intentionally requires a new
> build so JS and native stay compatible.

---

## ⚠️ Push notifications — needs your eyes

Push can't be verified from CI; it needs a real device + a linked EAS project.

1. **EAS project ID** must resolve. After `eas build` links the project, verify:

   ```bash
   cd ~/claude/mobile && grep -A3 '"extra"' app.json
   ```

   If there's no `eas.projectId`, run `npx eas-cli init` to link the project.
   Without it the app logs `[push] no EAS projectId` and no notifications fire.

2. **Test a real push** after opening the app on your phone and granting
   notification permission:

   ```bash
   curl -s -X POST "$B/api/morning/run" -H "Authorization: Bearer $NT" \
     -H "Content-Type: application/json" -d '{}'
   ```

   - `sent: 1` → it reached your phone.
   - `sent: 0, reason: "no_devices"` → no token registered yet (see step 1 /
     grant permission / reopen the app).

---

## What's in this release

- **Shopping:** UCP Shopify catalog (live), guaranteed UCP/web mix with Amazon
  always on page 1, over-fetch + in-app "Show more" paging.
- **Health:** Sleep score + Deep/REM breakdown, Recovery score (HRV/RHR/sleep,
  baseline-normalized), sleep debt, sleep consistency, training load (ACWR),
  unified HRV grading (50+/35-49/<35).
- **Wealth:** Savings rate, subscription detection, net-worth projection, fixed
  Wealth↔Insights spending mismatch.
- **Insights engine:** Significance-gated correlations (Pearson p-value +
  Benjamini-Hochberg FDR), personalized-baseline anomaly detection, widened
  leverage matrix with direction-aware advice, date-based forecast slopes +
  correct prediction intervals.
- **Logging:** Save-on-tap + rehydrate + midnight reset for check-in, habits,
  and per-exercise workout checks; weekly Sunday goals + life-context check-in
  that feeds the advisor and weekly review.
- **Daily content:** Library highlight, daily quote, Notion page, and the
  Wisdom-tab Readwise set are all day-static (locked on first pull, reset at
  midnight).
- **Automation:** 8am auto-refresh that pre-builds the briefing and pushes
  "Your morning briefing is ready!".
- **Hardening:** Briefing per-source + LLM timeouts, Notion pagination caps,
  constant-time auth with fail-loud warning, input validation, CORS allowlist,
  and ~25 audit fixes.

**Tests:** 68/68 backend passing; mobile typechecks clean.

## Handy diagnostics

```bash
# UCP flow (config → token → search), surfaces the real error:
curl -s "$B/api/shop/ucp-diagnose" -H "Authorization: Bearer $NT" | python3 -m json.tool

# Trigger the morning routine on demand (build + push):
curl -s -X POST "$B/api/morning/run" -H "Authorization: Bearer $NT" -H "Content-Type: application/json" -d '{}'

# Force a fresh briefing build:
curl -s "$B/api/briefing?refresh=1" -H "Authorization: Bearer $NT" >/dev/null && echo "rebuilt"
```
