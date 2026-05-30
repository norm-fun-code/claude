# Putting NormOS in the cloud (so your phone works anywhere)

This hosts the NormOS "brain" (backend + database) on a small private always-on
server, so the iPhone app works 24/7 — even with your Mac off. It's still *your*
server; the API token means only your phone can reach it.

We use **Render** because it deploys straight from your GitHub repo with no
servers to manage. Cost is ~$7/mo for the always-on service + a small Postgres.

---

## Part A — Deploy the brain (one time, ~10 min)

1. **Make a Render account** → [render.com](https://render.com), sign up with
   GitHub (the account that owns the `claude` repo).
2. **New → Blueprint.** Pick the `claude` repository. Render reads the included
   `render.yaml` and proposes a **web service (normos)** + a **Postgres database**.
   Click **Apply**.
3. Render builds it. While it builds, open the **normos** service → **Environment**
   and paste your AI key:
   - `ANTHROPIC_API_KEY` = your Claude key (from console.anthropic.com), **or**
   - `GEMINI_API_KEY` = your Gemini key (aistudio.google.com) if you prefer.
   - Add `GEMINI_API_KEY` regardless if you want library search/chat (embeddings).
   - Optional now or later: `NOTION_API_KEY`, `NOTION_PAGE_ID`, `READWISE_TOKEN`.
4. **Grab two things** from the normos service:
   - Its **URL** (e.g. `https://normos.onrender.com`).
   - The **`NORMOS_API_TOKEN`** value (Environment tab — Render auto-generated it).
5. Confirm it's alive: open `https://<your-url>/api/health` in a browser — you
   should see `{"status":"ok","database":"ok"}`.

Migrations run automatically on every deploy, and the morning routine
(ingest → analyze → nudge) plus the weekly review run **inside** the server on a
schedule — no extra setup. Set the `TZ` env var to your timezone so "7am" is
your 7am (default `America/New_York`).

---

## Part B — Point the phone app at it

In `mobile/src/config.ts`:

```ts
export const API_BASE = 'https://<your-url>';   // your Render URL, no trailing slash
export const API_TOKEN = '<the NORMOS_API_TOKEN value>';
```

Then build the app onto your iPhone (one time):

```bash
cd mobile
npm install
npx expo run:ios     # with your iPhone connected; approve signing in Xcode
```

Approve HealthKit + notifications on first launch. From then on the app works
anywhere on cellular or Wi-Fi, and the 7am nudge arrives on its own.

---

## Feeding it your data

- **Money (Monarch):** the cloud server can't see files on your Mac, so either
  (a) run `npm run ingest` locally pointed at the same database, or (b) add your
  Monarch CSVs to the repo's ignored import folder isn't an option in the cloud —
  simplest is to use the local route for the monthly import, or upload via a
  future endpoint. For now: keep Monarch import on your Mac against the cloud DB
  (set `DATABASE_URL` locally to the Render external connection string, then
  `npm run ingest`).
- **Readwise / Notion / Calendar / Weather:** these are API-based, so the cloud
  server pulls them itself on the morning schedule once their keys are set.
- **Apple Health:** pushed automatically from the phone app.

---

## Updating later

Because `autoDeploy` is on, every push to your repo's main branch redeploys the
server (and re-runs migrations) automatically. Nothing else to do.

## Health / troubleshooting

`https://<your-url>/api/health` is the quickest pulse check. For configuration,
the Render **Logs** tab shows startup + the scheduler line. Locally, `npm run
doctor` still works against any `DATABASE_URL`.
