# Monarch import drop folder

Drop your Monarch Money CSV export(s) **into this folder**, then run the ingest:

```bash
cd backend
npm run ingest        # imports any new/changed CSVs here
npm run analyze       # refresh trends, correlations, forecasts
```

## How to export from Monarch

In Monarch Money: **Settings → Data → Download**. Export whatever it offers —
NormOS auto-detects the file type, so you don't have to configure anything:

- **Transactions** (`Date, Merchant, Category, Account, Amount, Tags, …`)
  → becomes daily **spending**, **income**, and **net cashflow**, plus a
  searchable record of every transaction (so you can ask the life chat
  "what did I spend on travel last month?").
- **Balances** (`Date, Balance, Account` — one row per account)
  → becomes your **net worth** over time (NormOS sums the account balances for
  each date; credit-card/loan balances export as negative, so they subtract
  correctly). If the file includes history, you get a net-worth *trend*, not
  just one number.

## Cadence

Once a month is plenty — wealth patterns play out over months, not minutes.
Just drop the newest export here and run the two commands above. Re-dropping or
re-running is safe: NormOS remembers what it already imported (by file content)
and de-dupes transactions, so nothing double-counts.

## Privacy

Files in this folder are **git-ignored** — your financial data never leaves your
machine or gets committed. Only this README is tracked.
