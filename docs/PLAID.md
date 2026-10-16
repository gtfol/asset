# Plaid connections and hosting

Implementation status on October 16, 2026: the server and both clients implement official Link flows and provider synchronization. Automated tests use deterministic provider fixtures. **No request to a configured Plaid Sandbox account has been executed. No real institution or Production access has been verified.**

## Local use without Plaid

Manual accounts, CSV, budgets, review, holdings, and backups work without credentials. Demo data is synthetic and cannot be connected to Plaid. A private native workspace stays on the device; a shared workspace uses the authenticated Asset server.

## Configure connections

1. The deployment administrator configures one stable `TOKEN_ENCRYPTION_KEY` (32 random bytes encoded as 64 hexadecimal characters). It encrypts both per-user credentials and Item tokens. Preserve it in a protected secret store; replacing it without migrating ciphertext makes existing connections unreadable. It never belongs in a browser bundle, log, or financial backup.
2. For Vercel, configure an independent `CRON_SECRET` of at least 32 characters and set `PLAID_WORKER_ENABLED=true` with the minute-level cron in `vercel.json`. Set `PLAID_WEBHOOK_URL=https://asset.gtfol.dev/api/plaid/webhook` and `PLAID_WEB_REDIRECT_URI=https://asset.gtfol.dev/plaid/oauth`. The existing gtfol Vercel Pro deployment supports this schedule. A local persistent backend runs its own worker interval.
3. Each user signs into Asset with Google, opens **Connections**, and enters their own Plaid **Client ID** and **Production secret**. Asset verifies them with an institution-metadata request before saving. It encrypts both fields, binds the ciphertext to that user, and returns only the Client ID's last four characters. Shared deployment-wide Plaid credentials are not used.
4. Add the displayed web redirect URL under **Build → API → Allowed redirect URIs** in that user's own Plaid Dashboard. The Link token includes the deployment's webhook URL. Localhost cannot receive Plaid webhooks; local testing needs a separately approved HTTPS endpoint or the hosted app.
5. In the Dashboard's **Customize → Link → Data Transparency** section, configure the **default** customization with the use case **Track and manage your finances**, then **Publish changes**. Asset does not send a custom customization name. Its Link configuration uses English with the US and Canada. A missing published use case can produce `INVALID_LINK_CUSTOMIZATION`.
6. Choose a bank/card **Transactions** flow or a brokerage **Investments** flow, then connect through official Link. The user’s own Plaid account must have Production access for that product and institution. Asset does not collect bank passwords.
7. Check initial and historical loading, selected accounts, cached balances, review records, holdings timestamps, update mode, and disconnect. Record live bank-linking results separately from fixture tests.

The credential form clears the secret after submission and does not persist it in browser storage or native preferences. Secret rotation for the same Client ID is allowed while connected. Changing Client ID/environment or removing credentials requires disconnecting that user's active institutions first. A version check rejects an in-flight exchange if its credentials changed. Financial backups exclude provider credentials and access tokens. This implementation has not created a Plaid account, accepted a trial, purchased service, or accessed a bank.

An institution's generic Link error screen does not identify the cause. Check the failed Link session's error code and that institution's status in [OAuth institutions](https://dashboard.plaid.com/activity/status/oauth-institutions). Access differs by plan: Plaid's current Trial documentation includes Bank of America and other major OAuth institutions without full paid-plan registration requirements; older Limited Production and paid Production have different requirements. Do not prescribe an upgrade or a waiting period from the generic screen alone. See [OAuth access by plan](https://support.plaid.com/hc/en-us/articles/15769780649751-How-do-I-get-access-to-OAuth-institutions), [institution errors](https://plaid.com/docs/errors/institution/), and [Link customization errors](https://plaid.com/docs/errors/invalid-input/#invalid_link_customization).

Environment placeholders are in [`apps/web/.env.example`](../apps/web/.env.example). Asset reads process environment, not `.env` automatically. In this workspace, editing an ignored secrets file requires the owner's explicit permission.

## Web OAuth return

`/plaid/oauth` serves the app shell. Before Link opens, the browser saves only the short-lived Link token, product, optional connection ID, expiry, and a session-scoped identifier in `sessionStorage`. It never stores Plaid credentials or Item access tokens there. The callback accepts only the expected same-origin path, requires an unexpired context for the current login, and resumes Link with `receivedRedirectUri`. Exits and completion consume the attempt; stale callbacks cannot exchange it again. Connections requests include the initiating session identifier, so a login change in another tab is rejected.

## Native Link and OAuth

The app uses the official `LinkKit` Swift package, pinned to 7.2.2, and its SwiftUI session sheet. Link tokens are created on the server; the server never returns saved Plaid secrets or Item access tokens to the app.

Native token creation requires `PLAID_IOS_REDIRECT_URI`, an HTTPS Universal Link registered in Plaid. Before testing OAuth:

- Choose the actual app bundle identifier, Apple team, and HTTPS return domain.
- Add `applinks:<domain>` to the app's Associated Domains entitlement and signing configuration.
- Serve the Apple App Site Association file at that domain with the actual application identifier and return path, then register the same redirect URI in Plaid.
- Verify the installed SDK's OAuth return behavior on a signed device, including background/foreground transitions, cancellation, reauthentication, and newly selected accounts.

No placeholder domain has been registered or advertised as working. Native OAuth remains unverified until these deployment-specific values exist. See [Plaid iOS Link](https://plaid.com/docs/link/ios/) and [OAuth](https://plaid.com/docs/link/oauth/).

## Data synchronization

Transactions request up to 730 days when first initialized. `/transactions/sync` uses a persisted cursor, complete pagination, retries, and a restart from the original cursor if Plaid reports a pagination mutation. Data and final cursor commit in the same database transaction. A failure preserves the previous checkpoint.

Provider fields, identifiers, raw import values, and user edits are separate. Pending-to-posted replacements retain local identity and edits. Removed imports leave the ledger. Exact account/date/merchant/type/amount overlaps attach to an existing manual/CSV record; ambiguous near matches are not silently merged. A changed provider amount that would invalidate saved splits preserves the old split, flags the conflict, and requires explicit reconciliation before review.

Only selected accounts participate in reports. Net-worth inclusion is a separate choice. Update mode can add consented accounts; a fresh full cursor replay imports their available history. Duplicate active institution/product connections are rejected, and cleanup attempts to revoke the redundant Item with a separate bounded request. A failed cleanup reports a safe error code; external revocation is not claimed when it cannot be confirmed.

Investments uses `/investments/holdings/get` and separately paginates `/investments/transactions/get` for up to 24 months. Trades and investment transfers never become ordinary spending. Holdings and account snapshots are saved going forward; pre-link valuations are not invented. Missing prices/basis remain unavailable. Short positions and other values outside the supported nonnegative holdings model fail validation rather than being displayed as a fabricated long position.

`/accounts/get` returns cached balances. Asset does not request paid Balance, Refresh, Auth, recurring, payment, or transfer products. Provider price timestamps are displayed; no real-time quote claim is made. Portfolio balance growth is not presented as investment return.

## Webhooks and jobs

The public webhook looks up the active Item's owner and verifies the `Plaid-Verification` JWT using that owner's credentials, ES256, the fetched verification key, a five-minute freshness window, and the exact raw-body SHA-256 hash. Invalid signatures return 401; transient verification-key failures return 503 for retry. Unknown Items are acknowledged without mutation. Verified events are durably queued before 202 is returned. Repeated notifications coalesce into a newer requested generation, including identical notification bodies sent later; completion flags never regress.

The resumable worker runs every three seconds locally or every minute through authenticated Vercel Cron. Each connection has one durable queue row, requested/completed generations, a fenced lease, retry time, and staging state. Provider pages checkpoint before the request deadline; only a complete pass commits financial state and cursor atomically. Concurrent account-selection changes discard old staging. Expired leases can be reclaimed, while stale workers cannot commit. Failed jobs back off; periodic reconciliation revisits loading/stale connections when webhooks are missed.

Read-only provider calls retry transient network/429/5xx errors within a bounded deadline. One-use public-token exchange is not automatically retried. Error codes and connection states are shown without logging financial payloads, credentials, or tokens. Investments update events are covered by fixtures; actual Sandbox behavior must also be exercised explicitly because these webhooks do not generally occur naturally in Sandbox.

Disconnect calls `/item/remove` before discarding the encrypted token and stopping jobs. Keeping imported data is the default. Deleting imported records is a separate destructive choice requiring `DELETE`. Full backup/restore cannot overwrite a workspace with active connections.

## Hosting requirements

Use Vercel with dedicated PostgreSQL and minute-level Cron, or one continuously running Node service with persistent PostgreSQL and HTTPS. Run commands inside `apps/web`: `npm run build` builds the web client; `npm start` serves it, the API, and the worker. The `apps/web/Dockerfile` uses `apps/web` as its build context and provides this service shape; its container build has not yet been executed in this environment.

For embedded PostgreSQL, mount `/app/data` persistently and run only one service against that PGlite directory. For a hosted database, set `DATABASE_URL` to a dedicated TLS-protected PostgreSQL connection, including a dedicated Supabase database if desired. Only the backend should have database credentials. The migration enables RLS with no client policies; backend ownership/privileges and SQL owner checks enforce access. Do not expose these tables through Supabase client keys or reuse a database containing unrelated application data without reviewing migrations.

Set `APP_ORIGIN` to the web HTTPS origin and `HOST` appropriately. The supplied server defaults to loopback for local work. Browser sessions use HttpOnly, SameSite=Strict cookies and Secure cookies in production; native sessions use Keychain-held bearer tokens. Financial API responses are not cached. Use a private backup strategy for the database plus encryption key, and validate recovery before relying on it.

Vercel serves the client and same-origin API from `apps/web`; see [web deployment setup](../apps/web/README.md#vercel-and-supabase). Its database migrations run at API initialization, including the queue and per-user credential tables. The cron endpoint requires its independent bearer secret; user sessions cannot invoke it. Vercel Plaid routes require both `PLAID_WORKER_ENABLED=true` and a configured cron secret. The function uses a 45-second work budget within its 60-second limit. Supabase is optional storage for local use. Operational backups must preserve the database and its encryption key separately from user-exported financial backups.

## Production and developer testing

The owner explicitly approved enabling Production on October 16, 2026. Production is now the default for normal hosted setup; the form asks for a Client ID and Production secret without an environment picker. Credential validation calls the matching Production API, and Link requests only the user-selected product. Each user’s own Plaid Dashboard determines product and institution permissions, coverage, pricing, and limits. Enabling Asset’s integration does not grant Plaid Production access or establish support for a particular brokerage.

Sandbox remains available for local development or an explicit `PLAID_ALLOW_SANDBOX=true` server configuration. Existing Sandbox credentials keep their original environment and remain visibly identified as test data; they are never silently migrated to Production. Changing environments requires disconnecting active institutions first. Connection identity includes the environment, so a new Production connection never reuses a disconnected Sandbox connection ID. Retained Sandbox records are not relabeled as real-bank records; their connection stays visibly marked as test data. The provider accepts only the two hardcoded official API hosts and requires explicit per-user credentials, with no shared environment-key fallback. Tests mock both hosts and send no requests to real institutions.

Plaid has Sandbox and Production environments. A trial is limited real Production access, not another environment. Current eligibility and Item limits must be rechecked; an Item is a connection that may contain several accounts. No trial application, purchase, or bank connection was performed while enabling this feature. Users connect their own institutions through Link after saving approved Production credentials.

Required live validation includes signed native OAuth, webhook delivery and retry, limited history, unsupported institutions, stale data, reconnect/account changes, missing holdings, backup/recovery, and owner isolation. Automated fixture success alone cannot establish live Production behavior.

## Official references

Rechecked during implementation on October 15–16, 2026: [Transactions and initial history](https://plaid.com/docs/transactions/), [cached account balances](https://plaid.com/docs/api/accounts/), [Investments coverage and timestamps](https://plaid.com/docs/investments/), [institution support](https://plaid.com/docs/api/institutions/), [Sandbox limitations](https://plaid.com/docs/sandbox/), [webhook verification](https://plaid.com/docs/api/webhooks/webhook-verification/), and [Sandbox/Production/Trial differences](https://support.plaid.com/hc/en-us/articles/16110110883479-How-are-Sandbox-Production-Trial-plan-and-Limited-Production-different).

Hosting and OAuth: [Vercel Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Plaid Link API](https://plaid.com/docs/api/link/), and [web OAuth handling](https://plaid.com/docs/link/oauth/).

Environment routing: [Plaid API hosts and environment boundaries](https://plaid.com/docs/api/#api-host).
