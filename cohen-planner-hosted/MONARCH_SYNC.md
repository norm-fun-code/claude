# Direct Monarch financial data

Balances, holdings, categories and transactions share one server-only Monarch client and persisted session. No legacy bridge or shared-source reads are used. The first deployment migrates the last balance snapshot and pause preference, then deletes the retired bridge record. Account classifications and imported history are retained.

Configure the planner's `MONARCH_EMAIL` and `MONARCH_PASSWORD` for automatic renewal, plus an initial `MONARCH_TOKEN` or verified persisted session. Credentials never reach the browser. A 401 triggers one coalesced login and retry using a stable trusted-device UUID. Provider-required verification cannot be bypassed; `/monarch-reconnect` supports secure verification when necessary.

After database initialization, a background worker refreshes balances, holdings and a full 45-day transaction reconciliation once each Eastern calendar day, including startup catch-up. Failures retry after 30 minutes. Status persists across restarts and is included in the spending import status. PostgreSQL advisory locks serialize scheduled and manual imports across replicas. Pause stops automatic refreshes. Manual backfills retain full-history coverage.

Last observations survive provider failures, with a warning. Missing balances stay unknown. Holdings with missing cost basis show no invented all-time return. Price movement is distinct from contribution-adjusted investment performance. `asOf` is the API observation time; bank update times can differ.

## Monarch MCP (verification only)

Monarch's official MCP (`https://api.monarch.com/mcp`) can be connected under Spending → Data & import → *Monarch MCP check*. Connecting uses OAuth: the planner registers itself, you sign in to Monarch once in the browser (read-only scope `mcp:read`), and the server keeps a rotating refresh token, so no Monarch password is involved.

It is **not a data source yet**. Nothing reads from it except the comparison, which lines up accounts and balances, categories, transactions (by id, plus month totals) and holdings against what the current sync holds, and lists every difference. Switching the planner over to the MCP is a separate change, made once that comparison is clean on real data. `GET /api/monarch-mcp/tools` lists the tools and the arguments each takes (no financial data) for diagnosing a mismatch.
