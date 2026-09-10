# Monarch balances via NormOS

The planner no longer uses the retired MCP for balance sync or advisor account reads.

Production supports a dedicated server-to-server bridge: set the same random `PLANNER_BRIDGE_TOKEN` on NormOS and the planner, and set planner `NORMOS_URL` to the HTTPS NormOS origin. The credential grants only GET `/integrations/planner/accounts`; it cannot access the general NormOS API. NormOS uses its existing Monarch credential to refresh and publish account snapshots, retaining old data on failure. This path works with separate databases and takes priority over planner direct Monarch access. Redirects are refused to protect the integration credential.

- NormOS publishes validated account snapshots to `sources.config.plannerAccounts` under source `monarch` after direct API sync, balance CSV upload (including the Mac sync script), or balance file import.
- The planner reads this snapshot from the shared Railway PostgreSQL database. Deploy the companion NormOS change on main; the first successful account sync populates the bridge. No new credential is needed for this path. Separate databases require configuration before this path can work.
- If a direct API token is available as planner `MONARCH_TOKEN` or cached NormOS `sources.config.monarchToken`, the planner can retrieve fresh balances using NormOS's existing account query. It never exposes the token to the browser or advisor.
- The app checks on open, when returning to the foreground, and every five minutes while visible. Direct requests are coalesced and limited to one refresh per five minutes per process. Failed requests back off for five minutes. Imported data updates only when the existing NormOS/Mac sync runs.
- The displayed observation time is the source retrieval time or balance export date, not a bank refresh timestamp. More than 24 hours old is marked stale. Errors retain last-good data. Account balances do not automatically overwrite model assumptions.
- Planner exclusions remain independent of NormOS exclusions. Retirement uses the existing 401k/403b/457/pension name rules; IRAs remain in liquid net worth. The minimal NormOS account query does not provide account types, holdings, or institution metadata; names support classification where identifiable.
- Balance imports must contain a complete same-date account snapshot. Aggregate-only, invalid, empty, and duplicate-account snapshots cannot replace account details. Older exports cannot overwrite newer observations.
- The old MCP holdings/performance and YTD cashflow endpoints now return explicit unavailable responses instead of waiting for the retired service. The advisor can read dated account balances; it cannot invent transaction or holding details.

Validation: `npm test` in this directory. NormOS publisher tests are in `backend/test/monarch-planner-snapshot.test.js` on main.

API accounts without a balance are retained as named missing accounts, never converted to zero. Available balances populate Portfolio with an explicit incomplete subtotal label. Incomplete snapshots are excluded from plan-pace comparisons and milestone detection. CSV imports remain strict.
