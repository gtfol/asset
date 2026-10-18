# asset

Personal finance for web and native iPhone/iPad: spending pace, transaction review, budgets, accounts, investments, and cash flow. The interface follows gtfol's Lato typography, open layouts, monochrome line icons, and restrained blue charts.

| App | Source | Development |
| --- | --- | --- |
| Web and API | [apps/web](apps/web) | `cd apps/web && npm ci && npm run dev` |
| iPhone and iPad | [apps/ios](apps/ios) | Open `apps/ios/Asset.xcodeproj` in Xcode |

The repository follows [gtfol/capsule](https://github.com/gtfol/capsule)'s app layout. npm and its lockfile belong to the web app; Xcode and native scripts belong to the iOS app. There is no root package install. Run app-specific commands from that app's directory.

The authoritative calculation engine lives in `apps/web/shared`. iOS includes its generated JavaScriptCore bundle, fonts, and notices, so a normal Xcode build needs no npm install. After changing shared calculations or bundled resources, run `npm run native:resources` from `apps/web`; `npm run native:check` verifies that the native copies match.

## Checks

- Web: in `apps/web`, run `npm test` and `npm run build`.
- iOS: in `apps/ios`, run `node scripts/native-parity.mjs` and `node scripts/native-store-tests.mjs` on macOS, then build the Asset scheme in Xcode.
- GitHub Actions runs the relevant web and native checks when an app, shared resource, or workflow changes.

## Deployment

Set the Vercel project's **Root Directory to `apps/web`** and select **Vite**. The web app includes a same-origin API function and automatic database migrations. Configure a dedicated PostgreSQL `DATABASE_URL` and Google sign-in as described in [web hosting setup](apps/web/README.md#vercel-and-supabase). Each user adds their own Plaid Client ID and Production secret in Connections. Vercel Cron processes the resumable sync queue in the same deployment; configure the server encryption key and cron secret before enabling it.

The native app uses bundle ID `org.gtfol.asset`, signing team `J59ZSG67SJ`, and App Store Connect app `6824126579`. `apps/ios/ExportOptions.plist` configures TestFlight uploads. Both apps open directly into an empty workspace and save records on the device. Optional Google sign-in adds local records to the cloud workspace and syncs later edits; there is no demo or server-selection screen. Apple account sync remains disabled pending FinanceKit approval.

[Web setup](apps/web/README.md) · [iOS setup](apps/ios/README.md) · [Repository migration](docs/repository-migration.md)

## Product and verification

[Feature checklist and verified screenshots](docs/VERIFICATION.md) · [Design](docs/DESIGN.md) · [Research](docs/RESEARCH.md) · [Calculations and backups](docs/FINANCE.md)

Signed-in workspaces can track Bitcoin public addresses with current USD valuations and historical daily values, including available prices back to 2015. See [Bitcoin tracking](docs/BITCOIN.md) for coverage, privacy, and refresh limits, and [account connections](docs/ACCOUNT-CONNECTIONS.md) for connection coverage. [Venmo forwarding](docs/VENMO.md) can attach receipts to an existing imported account; server receiving setup is required.

Manual accounts and CSV imports work without sign-in or Plaid credentials. The normal connection flow uses each user’s Plaid Production credentials. Sandbox remains available for development. No goals, recurring-bill management, subscription tracker, AI chat, or model service are included.

## License

MIT is the [proposed project license](LICENSE.proposed), pending owner adoption. Dependency licenses remain independent; see the [dependency review](docs/DEPENDENCIES.md). Original code and identity; Copilot references inform workflows without copying its code, logo, or proprietary assets.
