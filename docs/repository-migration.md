# Repository layout

Asset now follows [gtfol/capsule](https://github.com/gtfol/capsule)'s independent `apps/web` and `apps/ios` layout. The initial implementation remains in Git history; this change moves the existing source and updates build references.

```text
apps/
  web/                 Web UI, API, shared finance engine, npm configuration
    public/            Web fonts, icons, and third-party notices
    scripts/           Web tooling and native resource synchronization
    tests/             TypeScript regression tests
  ios/                 Xcode project and native app
    Asset/             Swift code, assets, and bundled native resources
    AssetTests/        Native store regression harness
    scripts/           Native checks, project generation, and icon generation
.github/workflows/     Separate web and iOS checks
docs/                  Shared design, research, verification, and hosting notes
```

## Local checkouts

Run web commands from `apps/web`, including `npm ci`, `npm run dev`, `npm test`, and `npm run build`. Open `apps/ios/Asset.xcodeproj` for iOS. The root no longer contains a package manifest or lockfile.

Ignored files are left in place. Existing secrets, local databases, dependencies, and Xcode user state are not moved or deleted by this migration. Install web dependencies again in `apps/web`.

The default local database path is relative to the web process directory. A new run uses `apps/web/.data/postgres`. To keep an existing root database, supply `DATA_DIR` with the absolute path to that existing directory before starting the server. Do not mistake a new empty database for data loss, or commit either database. Existing environment settings must be supplied to the new process as before; the app does not automatically load `.env` files.

## Native resources

iOS includes the generated finance engine, Lato fonts, and notices in its own Resources directory. Normal Xcode builds and native regression scripts do not require the web app's npm dependencies.

When changing `apps/web/shared`, run `npm run native:resources` in `apps/web` and commit the updated native bundle. The same command synchronizes bundled fonts and notices. `npm run native:check` verifies these copies without rewriting them, and the iOS workflow runs that check when either the native app or its web source resources change.

## Vercel

Set **Root Directory to `apps/web`**, with build command `npm run build` and output directory `dist`. These are the new source/build paths, not a completed hosting setup: the API function, hosted database connection, and bank-sync worker still need deployment configuration. See [hosting requirements](PLAID.md).

The restructure does not change the iOS bundle ID, authentication, API routes, database schema, or financial calculations. No hosted app or TestFlight build is published by moving these files.
