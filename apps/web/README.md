# Asset web

The React web client, Node API, persistent storage, and background job processor live in this app. See the [repository README](../../README.md) for product status, [verification record](../../docs/VERIFICATION.md) for completed checks, and [Plaid setup](../../docs/PLAID.md) for provider configuration.

## Local development

Use Node.js 22.12 or newer. From the repository root:

```sh
cd apps/web
npm ci
npm run dev
```

Open **http://localhost:4317** and choose **Explore the demo**, or create a private account. Manual accounts and CSV imports need no cloud project or provider credentials.

The server binds to localhost by default and stores its embedded PostgreSQL database in `apps/web/.data/postgres`. An optional `DATABASE_URL` uses a separate PostgreSQL database. Configuration is listed in [.env.example](.env.example); the server reads process environment and does not automatically load an `.env` file.

## Checks and production build

Run these commands from `apps/web`:

```sh
npm test
npm run typecheck
npm run build
npm start
```

The build produces `dist` using only this directory. It does not require Xcode, an iOS checkout, or files outside the web app. `npm start` serves the built client, API, and continuous background worker; expose this service through HTTPS for production cookies.

Shared financial logic lives in `shared`. When changing it, regenerate the checked-in iOS calculation bundle from a full repository checkout:

```sh
npm run native:resources
npm run native:check
```

Native build and regression instructions are in [the iOS README](../ios/README.md). `node scripts/notices.mjs` refreshes third-party notices from installed packages and the repository's Plaid license file.

## Hosting

The current complete deployment runs as a persistent Node service. From the repository root, its Docker build context is the web app:

```sh
docker build -t asset-web apps/web
```

The image serves port 4317 and defaults to storing data under `/app/data/postgres`. Attach persistent storage at `/app/data`, or supply a dedicated PostgreSQL `DATABASE_URL`. Set `APP_ORIGIN` to the public HTTPS origin and provide provider credentials through the host's secret configuration. See [deployment requirements](../../docs/PLAID.md#hosting-requirements) before exposing a public service.

For a Vercel project, set **Root Directory** to `apps/web`, **Framework Preset** to Vite, **Build Command** to `npm run build`, and **Output Directory** to `dist`. Keep installation and build scoped to this app; the web build does not need access to the iOS directory. See Vercel's [monorepo setup](https://vercel.com/docs/monorepos) and [Vite guide](https://vercel.com/docs/frameworks/frontend/vite).

Those settings build the frontend only. The API and durable worker are not adapted for Vercel request functions. Authentication and financial actions call same-origin `/api` endpoints, so a static-only deployment is not a working Asset service. A persistent backend with deliberate routing/session configuration, or a separate API and job-platform adaptation, is still required before a Vercel deployment can be used.
