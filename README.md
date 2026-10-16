# Asset

Personal finance for web and native iOS: spending pace, transaction review, budgets, accounts, investments, and monthly/yearly cash flow. Original code and identity; no copied Copilot code, logo, or product assets.

The interface uses gtfol's Lato typography, open layouts, plain text navigation, and monochrome line icons. Blue is reserved for financial charts and keyboard focus. The source review includes Freewrite, Capsule, Motion, and Flow; Copilot Money's documented finance workflows inform the composition. See [research and references](docs/RESEARCH.md), [design decisions](docs/DESIGN.md), and [verification](docs/VERIFICATION.md).

## Run the web app

Requires Node 22.12+ (Node 24 recommended).

```sh
npm ci
npm run dev
```

Open **http://localhost:4317**. Choose **Explore the demo** for synthetic multi-year data, or create a private local server account. No cloud project, model key, or Plaid credentials are required for manual accounts and CSV.

The default database is embedded PostgreSQL (PGlite), persisted under `.data/postgres`. It is not an in-memory demo. Keep that folder private and back it up. The process binds to localhost by default. An optional `DATABASE_URL` switches to a dedicated PostgreSQL database, including Supabase PostgreSQL, without exposing database credentials to clients.

```sh
npm test                 # calculation, CSV, persistence, API isolation, and provider fixtures
npm run build            # type check, web production bundle, shared native calculation bundle
npm run test:native      # macOS: compare JavaScriptCore with the web/server engine
npm run test:native-store # macOS: native transaction paging and cache regression checks
npm start                # serve the production build and durable background jobs
```

Environment variables are documented in [.env.example](.env.example). The application reads process environment; it does not silently read a secrets file. Supply values through your process manager or your chosen local environment loader. Never commit secrets or database files.

## Run native iOS

The app is SwiftUI with Swift Charts and official Plaid LinkKit 7.2.2. It targets iOS 18+. Use Xcode 16.1 or newer with a compatible iOS SDK. Development was compiled with Xcode 26.6 and the iOS 26.5 simulator SDK.

```sh
npm ci
npm run native:resources
open ios/Asset.xcodeproj
```

Select the **Asset** scheme and an iPhone or iPad simulator, then Run. The checked-in project is ready to open; regenerating it is optional and requires the Ruby `xcodeproj` gem:

```sh
ruby scripts/generate-ios.rb
```

A native demo and private local workspace work without a server or network after installation. Local data uses atomic file writes with iOS complete file protection and is excluded from automatic cloud backup; export a full backup yourself. Demo and private files are separate.

To share a workspace between web and iOS, sign in to the **same Asset server**. The simulator can use `http://localhost:4317`. A physical iPhone requires a reachable HTTPS server and normal Apple signing. The native app stores its session in Keychain and caches the last server state. Remote changes require connectivity; there is no silent offline write queue or automatic merge.

The latest simulator build passes and is installed on iPhone and iPad. All six sections were visually checked on both devices in portrait; iPad Dashboard, Categories, and yearly Cash Flow were also inspected in landscape. Native checks covered larger text, Dashboard history taps, Cash Flow month selection/drill-down/future-month clearing, transaction editing, and dark Dashboard/Transactions. The final iPhone Cash Flow pass confirmed readable month axes, retained April values, and selection clearing on Year-to-Month change; Dashboard was restored to October with System appearance. The iPad rotation fix passed a full-screen landscape/upside-down portrait check, and upright portrait was restored. Accessibility scrolling worked, while direct touch hit-testing/gestures and a full VoiceOver session remain unverified. See the [verification record and screenshots](docs/VERIFICATION.md) for exact coverage.

## What is implemented

- Dashboard: remaining budget, actual cumulative spend, ideal pace, a separate deterministic projection, review queue, category budgets, and net this month.
- Transactions: automatic loading in batches of 80, date grouping, search/filters, edits, notes, exclusions, selected-row review, manual entry, splits, reusable merchant rules, and original import provenance.
- Categories: groups, line icons, monthly budgets, textual pace states, archive, and transaction drill-down. Older backups remain compatible; stored emoji are resolved to supported symbols rather than displayed.
- Accounts: grouped balances, assets/debt, recorded net-worth history, account history, inclusion controls, source/time, and explicit history coverage.
- Investments: account selection, holdings, allocation, security details, nullable quotes/basis, stale price labels, and a reason when return is unavailable.
- Cash flow: Month/Year, actual income/spending/net, like-for-like prior comparisons, January–December bars, category breakdown, and drill-down.
- CSV column mapping/preview/errors/deduplication, CSV export, and versioned full backup/restore. Repeated imports retain their original identity after transaction edits or merchant-rule renames.
- Authenticated, owner-isolated server storage and a real **Sandbox-only Plaid integration**, with fixture tests. Credentials are still required to verify live Sandbox execution.

No goals, recurring-bill management, upcoming bills, subscription tracker, AI chat, AI insights, or model service.

## Calculation conventions

Money is integer cents. Different currencies are never combined; reporting currency filters totals. Imported transaction dates remain date-only calendar values, and reporting boundaries use the configured timezone. Positive card/loan balances mean debt owed; negative liability balances mean a credit. Account balance and transaction activity are separate records.

Posted spending minus refunds counts once. Split parents are replaced by their parts. Pending/removed records, transfers, card payments, and investment trades/transfers do not count as ordinary spend or income. Budget-excluded activity stays out of budget pace; Cash Flow has a separate include-excluded toggle shared with Dashboard's net summary.

Projection = eligible spend to date × calendar days in month ÷ elapsed days. It is **Asset's transparent estimate**, not a claimed Copilot algorithm. It requires complete history, disappears for completed historical months, and can be distorted by early-month or lumpy spending. There is no recurring engine and no deduction for expected future bills.

Complete coverage must be established per account. CSV import alone does not prove completeness; confirm a known range in manual account settings. Plaid history may be shorter than requested. Missing history is labeled and suppresses unreliable comparisons/projections.

Portfolio balance growth is never labeled investment return. Complete contribution/valuation history is needed for cash-flow-adjusted return; until then, it is unavailable. Account balances can differ from holdings because of cash, missing securities, and timestamps.

## Backup and restore

Use Settings → Full backup for complete recovery, including splits, rules, budgets, balances, and holding snapshots. CSV is a readable transaction export, not a full-state backup. Provider secrets and raw provider payloads are not exported. Connected records restore as disconnected manual data.

Restore validates the schema, reference integrity, split sums, and demo/private separation. Disconnect active connections before restoring to avoid invalidating their cursors. Web downloads a recovery backup first; iOS saves `before-restore.json` locally before replacing the workspace and can share that recovery file. Preserve a separate external backup before uninstalling or clearing app data.

## Plaid and hosting

See [Plaid setup and deployment](docs/PLAID.md). **Sandbox execution, native OAuth, and all Production access remain unverified until configured and tested.** Production requests are blocked in code. No provider subscription, real-bank connection, paid refresh, or public deployment has been made.

The backend needs persistent PostgreSQL, HTTPS, a webhook endpoint, and a continuously running job processor. The supplied Dockerfile supports that service model. Supabase can host the database; a Vercel-only deployment needs a separate durable worker or a deliberate serverless job adaptation. Do not deploy this stateful worker as an ordinary request-only function.

## License and dependencies

**Proposed project license: MIT**, included as [LICENSE.proposed](LICENSE.proposed) for owner review before adoption. Dependency licenses remain independent. Lato is bundled under the SIL Open Font License; see [dependency review](docs/DEPENDENCIES.md). Plaid's SDK and service have their own terms.
