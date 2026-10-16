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

Set the Vercel project's **Root Directory to `apps/web`**. The current app still needs its Vercel API entry point, hosted PostgreSQL connection, and background-job deployment configured; importing this repository alone does not complete those steps. See [hosting requirements](docs/PLAID.md).

The native app keeps bundle ID `org.gtfol.asset`. Signing, App Store Connect, and TestFlight upload are not configured. Local native demo/manual workspaces work without a server; shared web/iPhone data requires the same reachable HTTPS Asset server.

[Web setup](apps/web/README.md) · [iOS setup](apps/ios/README.md) · [Repository migration](docs/repository-migration.md)

## Product and verification

[Feature checklist and verified screenshots](docs/VERIFICATION.md) · [Design](docs/DESIGN.md) · [Research](docs/RESEARCH.md) · [Calculations and backups](docs/FINANCE.md)

Manual accounts, CSV, and synthetic demo data work without Plaid credentials. The provider integration is Sandbox-only; live Sandbox execution and Production access remain unverified. No goals, recurring-bill management, subscription tracker, AI chat, or model service are included.

## License

MIT is the [proposed project license](LICENSE.proposed), pending owner adoption. Dependency licenses remain independent; see the [dependency review](docs/DEPENDENCIES.md). Original code and identity; Copilot references inform workflows without copying its code, logo, or proprietary assets.
