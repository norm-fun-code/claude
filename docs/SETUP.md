# Turning NormOS on — a plain-language guide

You don't need to be technical. This walks you through it in order. Budget ~15
minutes (plus a one-time phone build if you want the iPhone app).

Everything runs **on your own machine** — your data never leaves it.

---

## Step 1 — Start it (one command)

In a terminal, from the project folder:

```bash
./setup.sh
```

That starts the private database, installs everything, and creates your settings
file (`backend/.env`). If you want to **see it work immediately with realistic
sample data**, run `./setup.sh --demo` instead.

> Don't have Docker? Install **Docker Desktop** (docker.com), then run it again.

---

## Step 2 — Add your keys

Open **`backend/.env`** in any text editor and paste in the values you have. You
don't need all of them — start with the AI, then add sources over time.

| What | Setting | Where to get it | Needed? |
|---|---|---|---|
| **The AI brain** | `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys | **Yes** (Claude — recommended) |
| …or Google's AI | `GEMINI_API_KEY` | aistudio.google.com → API key | or this instead |
| **Money** | drop a CSV in `backend/imports/monarch/` | Monarch → Settings → Data → Download | for Wealth |
| **Highlights** | `READWISE_TOKEN` | readwise.io/access_token | for Wisdom |
| **Notes** | `NOTION_API_KEY` + `NOTION_PAGE_ID` | notion.so → Settings → Connections | for Wisdom |
| **Calendar + email** | `GOOGLE_*` | run `npm --prefix backend run get-tokens` | for Today |
| **Weather** | `OPENWEATHER_API_KEY` | openweathermap.org (free) | optional |

Embeddings (for library search/chat) use your Gemini key by default, or a fully
local model — see "Privacy" below.

---

## Step 3 — Check what's ready

Any time, run:

```bash
npm --prefix backend run doctor
```

It prints a plain checklist: ✓ working, • optional/not set yet, ✗ needs fixing.
When the AI shows ✓ and the database is green, you're good.

---

## Step 4 — Pull in your data and analyze

```bash
npm --prefix backend run ingest    # pull connectors + import Monarch CSVs
npm --prefix backend run analyze   # find trends, correlations, forecasts
```

Set these to run automatically each morning (optional) with cron/launchd:

```
0 6 * * *  cd /path/to/normos/backend && npm run ingest && npm run analyze && npm run nudge
0 7 * * 1  cd /path/to/normos/backend && npm run review     # weekly review, Mondays
```

---

## Step 5 — Start the server

```bash
npm --prefix backend start
# → NormOS running on http://localhost:3001
```

---

## Step 6 — The phone app (optional, for HealthKit + nudges)

The iPhone app needs a one-time build (it reads Apple Health and receives push
nudges, which Expo Go can't do):

```bash
cd mobile
npm install
npx expo run:ios     # builds + installs on a connected iPhone
```

In `mobile/src/config.ts`, set `API_BASE` to your Mac's local IP so the phone can
reach the backend on your Wi-Fi. Approve HealthKit + notification prompts on first
launch.

---

## Privacy

NormOS is self-hosted on purpose.

If you ever host the backend on a server, set `NORMOS_API_TOKEN` (and the matching
`API_TOKEN` in `mobile/src/config.ts`) to require authentication.

---

## Stuck?

`npm --prefix backend run doctor` is the fastest answer — it tells you exactly
what's missing and the next step for each item.
