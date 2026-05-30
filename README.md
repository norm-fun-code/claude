# NormOS

A personal intelligence platform. NormOS accumulates your life data across
health, wealth, productivity, and learning, discovers relationships in it, and
surfaces the highest-leverage action to take next. It began as a morning
briefing app and is evolving into a lifelong personal operating system.

> **Design north star:** not another dashboard that re-fetches and forgets — a
> data spine that *remembers*, with an intelligence layer on top. See
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Architecture

```
backend/   Node.js API + data spine (Postgres/TimescaleDB/pgvector)
mobile/    Expo React Native app (runs on your iPhone)
docs/      Architecture & roadmap
```

The mobile app connects to the backend over your local network. The backend
handles all API calls (Gmail, Notion, Gemini, Google Calendar, Weather),
persists every observation into a canonical time-series + document store, and
exposes query/ingestion endpoints. The mobile app adds on-device HealthKit data
(HRV, sleep, steps, resting HR), which it pushes to the backend to persist.

---

## 0. Database (the data spine)

NormOS is self-hosted: your data lives on your machine. The spine is Postgres +
TimescaleDB + pgvector, run via Docker.

```bash
# from the repo root
docker compose up -d                 # start Postgres + TimescaleDB + pgvector
npm --prefix backend install         # install backend deps (includes pg)
npm --prefix backend run migrate     # apply the schema
```

Then ingest on demand or on a schedule:

```bash
npm --prefix backend run ingest      # run all server-side connectors
```

`DATABASE_URL` in `backend/.env` defaults to the docker-compose credentials.

---

## 1. Backend Setup

### Install dependencies

```bash
cd backend
npm install
```

### Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in the values:

| Key | Where to get it |
|-----|----------------|
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com) → Get API key |
| `NOTION_API_KEY` | Notion Settings → Connections → Develop integrations → New integration |
| `NOTION_PAGE_ID` | The ID at the end of your Notion page URL |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → OAuth 2.0 Client ID (Desktop app type) |
| `GOOGLE_DOC_ID` | The ID from your Google Doc URL |
| `WEATHER_LAT` / `WEATHER_LON` | Your coordinates (decimal degrees) |
| `READWISE_TOKEN` | [readwise.io/access_token](https://readwise.io/access_token) — Learning connector (Kindle, articles, podcasts) |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` | [Plaid Dashboard](https://dashboard.plaid.com) → Team Settings → Keys — Wealth connector |
| `PLAID_ENV` / `PLAID_ACCESS_TOKENS` | `sandbox`/`development`/`production`; one access_token per institution (via Plaid Link), comma-separated |
| `NOTION_WISDOM_PAGE_ID` | Optional — parent page of your Notion "wisdom" sub-pages (defaults to `NOTION_PAGE_ID`) |

### Get Google OAuth tokens (one-time)

Enable these APIs in Google Cloud Console:
- Gmail API
- Google Calendar API
- Google Docs API

Then run:

```bash
npm run get-tokens
```

This opens a browser for OAuth consent. After approving, copy the printed `GOOGLE_REFRESH_TOKEN` value into your `.env`.

### Weather setup

**Option A: WeatherKit (requires Apple Developer account, $99/yr)**

1. In [App Store Connect](https://appstoreconnect.apple.com), go to Users and Access → Keys → WeatherKit
2. Create a key, download the `.p8` file
3. Note your Team ID, Key ID, and create a Service ID in your Apple Developer account
4. Fill in the `WEATHERKIT_*` variables in `.env` and set `WEATHERKIT_PRIVATE_KEY_PATH` to the absolute path of the `.p8` file

**Option B: OpenWeatherMap (free)**

1. Sign up at [openweathermap.org](https://openweathermap.org/api)
2. Get a free API key
3. Set `OPENWEATHER_API_KEY` in `.env`
4. Leave the `WEATHERKIT_*` variables empty — the backend auto-falls back

### Start the backend

```bash
cd backend
node server.js
# → Morning Dashboard backend running on http://localhost:3001
```

Test it:
```bash
curl http://localhost:3001/api/health
```

---

## 2. Mobile Setup

### Prerequisites

- Xcode installed (Mac App Store)
- iPhone connected via USB (or use iOS Simulator, but HealthKit needs a real device)
- Node.js 18+

### Install dependencies

```bash
cd mobile
npm install
```

### Configure your Mac's local IP

In `mobile/src/hooks/useBriefing.ts`, update the `API_URL` if you're testing on a real device (your Mac and iPhone must be on the same Wi-Fi):

```ts
// For real device testing, use your Mac's local IP:
const API_URL = 'http://192.168.x.x:3001/api/briefing';

// For simulator only, localhost works:
const API_URL = 'http://localhost:3001/api/briefing';
```

Find your Mac's IP: System Settings → Wi-Fi → Details → IP Address.

### Build and run (development build)

The app requires a development build (not Expo Go) because it uses HealthKit.

```bash
cd mobile
npx expo run:ios
```

This builds the app and installs it on your connected iPhone. Xcode will open for signing — select your Apple ID in the Signing & Capabilities tab.

On first launch, the app will request HealthKit permissions. Approve all of them.

---

## 3. Daily Use

Each morning:

1. Start the backend (if not already running):
   ```bash
   npm run backend
   ```
2. Open the **Morning** app on your iPhone
3. Pull down to refresh if needed

The briefing is generated fresh each time you open the app. Gemini summarizes your newsletters and generates insights — this takes about 10–15 seconds on first load.

---

## Dashboard Sections

| Section | Data source |
|---------|------------|
| **Health** | Apple Watch via HealthKit (HRV, sleep, steps, resting HR, active calories) |
| **Weather** | WeatherKit or OpenWeatherMap via backend |
| **Workout** | Day-of-week plan + HRV-adjusted recommendation |
| **Calendar** | Google Calendar via backend |
| **Quote + Insight** | Random line from your Google Doc + Gemini reflection |
| **Notion Wisdom** | Random child page from your Notion workspace + Gemini reflection |
| **Newsletters** | Gmail unread threads summarized by Gemini |
| **Finance & Markets** | Extracted from newsletter emails by Gemini |
| **Urgent Inbox** | Non-newsletter emails flagged as action-required |

---

## HRV Zones

The workout card uses your live HRV to adjust today's recommendation:

| HRV | Status | Action |
|-----|--------|--------|
| ≥ 50 ms | 🟢 Green | Train as planned |
| 30–49 ms | 🟡 Yellow | Reduce intensity 10–20% |
| < 30 ms | 🔴 Red | Mobility/walk only |
