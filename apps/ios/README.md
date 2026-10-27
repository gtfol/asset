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

The bundle identifier is `org.gtfol.asset`; the deployment target is iOS 18. The app opens directly into a private workspace and saves manual records and CSV imports without a server. Shared workspaces use the web app's server API. Signed-in users can connect real accounts with their own Plaid Production credentials once the server and native OAuth prerequisites below are configured.

## Google sign-in

Google is the only account sign-in method. Sign in from Settings only when you want account sync. The app uses `https://asset.gtfol.dev`; normal UI has no server-address setting. Manual accounts and CSV imports work without an account.

The app creates an in-memory random PKCE verifier and sends its SHA-256 challenge to `POST /api/auth/google/start` with `client: "ios"`. A system `ASWebAuthenticationSession` opens the returned URL and receives `org.gtfol.asset://auth/callback?code=…`. Only the one-time code is accepted in this callback. The app exchanges that code and the verifier at `POST /api/auth/google/exchange`, stores the bearer session in Keychain, then adds local records to the authenticated workspace without replacing existing cloud records. Later edits are saved locally before sync, and pending operations survive restarts and lost responses. Cancelling the sheet or changing workspace prevents a pending sign-in from replacing local state. The browser flow requires Google OAuth configuration on the server; the app has no Google client secret.

## Source layout

- `Asset/AssetApp.swift` — app entry point and appearance environment.
- `Asset/UI/` — native screens, controls, editors, and settings.
- `Asset/Persistence/Store.swift` — workspace storage, API access, shared-engine bridge, and transaction paging.
- `Asset/Resources/` — the checked-in JavaScriptCore calculation bundle, Lato fonts, OFL license, and dependency notices.
- `AssetTests/NativeStoreTests.swift` — regression checks against the production Store and paging code.
- `scripts/` — native verification and optional project/icon regeneration tools.

## Plaid connections

Each signed-in user supplies their own Plaid Client ID and Production secret in Connections. Production is the default, and normal hosted setup does not show an environment picker. Sandbox remains available when the server permits it for development or when a user already has saved Sandbox credentials. Existing Sandbox credentials are preserved, and their connection rows remain labeled as test data even after disconnection. To start Production connections, disconnect the test institutions and explicitly save Production credentials. Saving Production credentials does not convert previously imported test data. Link uses the saved environment, regardless of an unsaved form selection.

Credentials are validated and encrypted on the server. The app displays only the saved Client ID suffix and keeps the secret input in memory until submission. A secret can be rotated for the same Plaid account while institutions are connected; changing accounts or environments and removing credentials requires disconnecting those institutions first. Local workspaces do not use Plaid credentials.

Native Link uses the pinned LinkKit 7 session API. The server must supply a registered `PLAID_IOS_REDIRECT_URI` when creating native Link tokens. Before bank OAuth can work, configure a real Apple signing team, an `applinks:asset.gtfol.dev` Associated Domains entitlement, and the matching `/.well-known/apple-app-site-association` on the website using that team's actual application identifier prefix and `org.gtfol.asset`. Register the exact HTTPS redirect URI in each user's Plaid Dashboard. The project deliberately does not invent a signing team or application prefix, and the Google sign-in custom scheme is not a Plaid OAuth redirect. Verify ordinary Link and bank OAuth/app-to-app separately; a Sandbox or non-OAuth institution does not verify the real-bank universal-link return path. Production access and the requested products must be enabled on the user's Plaid account.

## Verify independently

Install Node.js 22 or newer and Xcode command line tools. No `npm install` is needed here. From `apps/ios`:

```sh
node scripts/native-parity.mjs
node scripts/native-store-tests.mjs
```

The first command checks that Node and JavaScriptCore produce identical results from the bundled engine for calculations, edits, imports, and backup restoration. The second compiles the production Store with its regression harness, including PKCE and callback validation, cache invalidation, filtering, paging, and a large ledger. Both commands use temporary directories and the checked-in engine. They can also be invoked by absolute path from another working directory.

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

Regenerate the refined Asset Layers icon with Core Graphics (the same geometry used in the web SVG and native header) with:

```sh
swift scripts/render-icon.swift
```

These scripts resolve paths from their own location and preserve `Asset/Info.plist`. Signing credentials and local environment files are not part of either generator.
