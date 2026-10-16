# Asset for iOS

Native SwiftUI app for iPhone and iPad, with a checked-in Xcode project and bundled calculation engine, fonts, and license notices. The app can be built without installing the web app or its Node dependencies.

## Build

Use macOS with Xcode 26 or newer. From this directory, open `Asset.xcodeproj`, select the **Asset** scheme and an iPhone or iPad simulator, then Run. Xcode resolves the pinned Plaid LinkKit 7.2.2 package on the first build. A physical device also needs your signing team.

For an unsigned simulator build:

```sh
xcodebuild -project Asset.xcodeproj -scheme Asset \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/asset-derived CODE_SIGNING_ALLOWED=NO build
```

The bundle identifier is `org.gtfol.asset`; the deployment target is iOS 18. The local demo and private workspace work without a server. Shared workspaces use the web app's server API. Real bank connections are not enabled; Plaid is limited to Sandbox.

## Source layout

- `Asset/AssetApp.swift` — app entry point and appearance environment.
- `Asset/UI/` — native screens, controls, editors, and settings.
- `Asset/Persistence/Store.swift` — workspace storage, API access, shared-engine bridge, and transaction paging.
- `Asset/Resources/` — the checked-in JavaScriptCore calculation bundle, Lato fonts, OFL license, and dependency notices.
- `AssetTests/NativeStoreTests.swift` — regression checks against the production Store and paging code.
- `scripts/` — native verification and optional project/icon regeneration tools.

## Verify independently

Install Node.js 22 or newer and Xcode command line tools. No `npm install` is needed here. From `apps/ios`:

```sh
node scripts/native-parity.mjs
node scripts/native-store-tests.mjs
```

The first command checks that Node and JavaScriptCore produce identical results from the bundled engine for calculations, edits, imports, and backup restoration. The second compiles the production Store with its regression harness, including cache invalidation, filtering, paging, and a large ledger. Both commands use temporary directories and the checked-in engine. They can also be invoked by absolute path from another working directory.

These checks validate the bundled engine. Freshness against the authoritative shared TypeScript sources is checked separately below.

## Refresh shared resources

The authoritative calculation code lives in `../web/shared/`. Make financial calculation changes there, then refresh the native bundle from the web app:

```sh
cd ../web
npm ci
npm run native:resources
npm run native:resources -- --check
```

The refresh also copies the web app's bundled Lato fonts and dependency notices into `Asset/Resources`. Commit the refreshed resources with the shared source change. `--check` compares all generated/copied resources without writing files and exits with an error if they are missing or stale. It is suitable for CI after web dependencies are installed.

## Optional generated assets

Normal builds do not require Ruby or project regeneration. If source groups or resource references change, regenerate the checked-in project with the `xcodeproj` Ruby gem installed:

```sh
ruby scripts/generate-ios.rb
```

Regenerate the original lettermark from the local Lato font with:

```sh
swift scripts/render-icon.swift
```

These scripts resolve paths from their own location and preserve `Asset/Info.plist`. Signing credentials and local environment files are not part of either generator.
