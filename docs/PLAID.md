# Plaid Sandbox and hosting

Implementation status on October 15, 2026: the server and both clients implement official Link flows and provider synchronization. Automated tests use deterministic provider fixtures. **No request to a configured Plaid Sandbox account has been executed. No real institution or Production access has been verified.**

## Local use without Plaid

Manual accounts, CSV, budgets, review, holdings, and backups work without credentials. Demo data is synthetic and cannot be connected to Plaid. A private native workspace stays on the device; a shared workspace uses the authenticated Asset server.

## Configure Sandbox

1. Use an existing Plaid developer account's **Sandbox** credentials. Do not put them in the browser or Xcode project. This build has not created a Plaid account, accepted a trial, purchased service, or accessed a bank.
2. Supply `PLAID_CLIENT_ID`, `PLAID_SECRET`, and an independently generated 32-byte `TOKEN_ENCRYPTION_KEY` (64 hexadecimal characters) to the backend process. Keep `PLAID_ENV=sandbox`. The server rejects every other environment.
3. Preserve the encryption key in a protected secret store. Losing it makes stored Item tokens unusable; changing it without migrating ciphertext requires reconnection. Neither access tokens nor this key belong in logs or exported financial backups.
4. For asynchronous updates, set `PLAID_WEBHOOK_URL` to the approved deployment's HTTPS `/api/plaid/webhook` endpoint. Localhost cannot receive Plaid's webhooks. A public tunnel or deployment needs the owner's approval before exposing the service.
5. Start the backend, create a private Asset workspace, and open Connections. Choose a bank/card **Transactions** flow or a brokerage **Investments** flow. Use only Plaid's documented Sandbox test credentials inside official Link.
6. Check initial and historical loading, selected accounts, cached balances, review records, holdings timestamps, update mode, and disconnect. Record actual Sandbox results separately from the fixture suite.

Environment placeholders are in [`apps/web/.env.example`](../apps/web/.env.example). Asset reads process environment, not `.env` automatically. In this workspace, editing an ignored secrets file requires the owner's explicit permission.

## Native Link and OAuth

The app uses the official `LinkKit` Swift package, pinned to 7.2.2, and its SwiftUI session sheet. Link tokens are created on the server; the app receives no Plaid secret or Item access token.

Native token creation requires `PLAID_IOS_REDIRECT_URI`, an HTTPS Universal Link registered in Plaid. Before testing OAuth:

- Choose the actual app bundle identifier, Apple team, and HTTPS return domain.
- Add `applinks:<domain>` to the app's Associated Domains entitlement and signing configuration.
- Serve the Apple App Site Association file at that domain with the actual application identifier and return path, then register the same redirect URI in Plaid.
- Verify the installed SDK's OAuth return behavior on a signed device, including background/foreground transitions, cancellation, reauthentication, and newly selected accounts.

No placeholder domain has been registered or advertised as working. Native OAuth remains unverified until these deployment-specific values exist. See [Plaid iOS Link](https://plaid.com/docs/link/ios/) and [OAuth](https://plaid.com/docs/link/oauth/).

## Data synchronization

Transactions request up to 730 days when first initialized. `/transactions/sync` uses a persisted cursor, complete pagination, retries, and a restart from the original cursor if Plaid reports a pagination mutation. Data and final cursor commit in the same database transaction. A failure preserves the previous checkpoint.

Provider fields, identifiers, raw import values, and user edits are separate. Pending-to-posted replacements retain local identity and edits. Removed imports leave the ledger. Exact account/date/merchant/type/amount overlaps attach to an existing manual/CSV record; ambiguous near matches are not silently merged. A changed provider amount that would invalidate saved splits preserves the old split, flags the conflict, and requires explicit reconciliation before review.

Only selected accounts participate in reports. Net-worth inclusion is a separate choice. Update mode can add consented accounts; a fresh full cursor replay imports their available history. Duplicate active institution/product connections are rejected and the redundant Item is revoked.

Investments uses `/investments/holdings/get` and separately paginates `/investments/transactions/get` for up to 24 months. Trades and investment transfers never become ordinary spending. Holdings and account snapshots are saved going forward; pre-link valuations are not invented. Missing prices/basis remain unavailable. Short positions and other values outside the supported nonnegative holdings model fail validation rather than being displayed as a fabricated long position.

`/accounts/get` returns cached balances. Asset does not request paid Balance, Refresh, Auth, recurring, payment, or transfer products. Provider price timestamps are displayed; no real-time quote claim is made. Portfolio balance growth is not presented as investment return.

## Webhooks and jobs

The public webhook verifies the `Plaid-Verification` JWT using ES256, the fetched verification key, a five-minute freshness window, and the exact raw-body SHA-256 hash. Invalid requests return 401. Valid events are durably queued before 202 is returned. Duplicate bodies are deduplicated, and completion flags never regress when events arrive out of order.

The server runs a worker every three seconds, claims jobs with a lease, and retries failures with backoff. The provider adapter retries transient network/429/5xx errors. Error codes and connection states are shown without logging financial payloads or tokens. Investments update events are covered by fixture tests; actual Sandbox behavior must also be exercised explicitly because these webhooks do not generally occur naturally in Sandbox.

Disconnect calls `/item/remove` before discarding the encrypted token and stopping jobs. Keeping imported data is the default. Deleting imported records is a separate destructive choice requiring `DELETE`. Full backup/restore cannot overwrite a workspace with active connections.

## Hosting requirements

Use one continuously running Node service with persistent PostgreSQL and HTTPS. Run commands inside `apps/web`: `npm run build` builds the web client; `npm start` serves it, the API, and the worker. The `apps/web/Dockerfile` uses `apps/web` as its build context and provides this service shape; its container build has not yet been executed in this environment.

For embedded PostgreSQL, mount `/app/data` persistently and run only one service against that PGlite directory. For a hosted database, set `DATABASE_URL` to a dedicated TLS-protected PostgreSQL connection, including a dedicated Supabase database if desired. Only the backend should have database credentials. The migration enables RLS with no client policies; backend ownership/privileges and SQL owner checks enforce access. Do not expose these tables through Supabase client keys or reuse a database containing unrelated application data without reviewing migrations.

Set `APP_ORIGIN` to the web HTTPS origin and `HOST` appropriately. The supplied server defaults to loopback for local work. Browser sessions use HttpOnly, SameSite=Strict cookies and Secure cookies in production; native sessions use Keychain-held bearer tokens. Financial API responses are not cached. Use a private backup strategy for the database plus encryption key, and validate recovery before relying on it.

A Vercel-only request-function deployment is not configured. Set the Vercel Root Directory to `apps/web`; the API still needs a function entry point, and the current durable worker needs a continuously running backend or a deliberate job-platform adaptation. Supabase is optional storage, not a requirement for local use. Public registration, abuse protection, recovery/email verification, reverse-proxy limits, secret rotation, observability, and operational backups need review before a public service. This release is a local/personal application, not a certified multi-tenant financial service.

## Separate live-access gate

Production is blocked by code even when production credentials are supplied. Before changing that restriction, obtain the owner's explicit approval and verify actual access in the developer's Plaid Dashboard: enabled products, institution permissions, country/account coverage, pricing, trial eligibility, and limits. Do not assume any particular brokerage is available.

Plaid has Sandbox and Production environments. A trial is limited real Production access, not another environment. Current eligibility and Item limits must be rechecked; an Item is a connection that may contain several accounts. No trial application or real-bank connection is authorized by this build.

Required live validation includes signed native OAuth, webhook delivery and retry, limited history, unsupported institutions, stale data, reconnect/account changes, missing holdings, backup/recovery, and owner isolation. Sandbox success alone cannot establish Production readiness.

## Official references

Rechecked during implementation on 2026-10-15: [Transactions and initial history](https://plaid.com/docs/transactions/), [cached account balances](https://plaid.com/docs/api/accounts/), [Investments coverage and timestamps](https://plaid.com/docs/investments/), [institution support](https://plaid.com/docs/api/institutions/), [Sandbox limitations](https://plaid.com/docs/sandbox/), [webhook verification](https://plaid.com/docs/api/webhooks/webhook-verification/), and [Sandbox/Production/Trial differences](https://support.plaid.com/hc/en-us/articles/16110110883479-How-are-Sandbox-Production-Trial-plan-and-Limited-Production-different).
