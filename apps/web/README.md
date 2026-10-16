# Asset web

The React web client, Node API, persistent storage, and background job processor live in this app. See the [repository README](../../README.md) for product status, [verification record](../../docs/VERIFICATION.md) for completed checks, and [Plaid setup](../../docs/PLAID.md) for provider configuration.

## Local development

Use Node.js 22.12 or newer. From the repository root:

```sh
cd apps/web
npm ci
npm run dev
```

Open **http://localhost:4317** and choose **Explore the demo**, or sign in with Google after configuring Google OAuth. Manual accounts and CSV imports need no cloud project or provider credentials.

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

## Vercel and Supabase

Import `gtfol/asset` with **Root Directory `apps/web`**, **Framework Preset Vite**, **Build Command `npm run build`**, **Output Directory `dist`**, and Node.js 24. `vercel.json` routes `/api/*` to the Express function and serves the built client from the CDN. There is no separate API domain.

Set these in Vercel's environment settings, then redeploy:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | A dedicated Supabase project's PostgreSQL **transaction pooler** connection string, port **6543**, with its database password. URL-encode reserved password characters. |
| `APP_ORIGIN` | `https://asset.gtfol.dev` |
| `GOOGLE_CLIENT_ID` | The Google OAuth Web application client ID. |
| `GOOGLE_CLIENT_SECRET` | Its client secret, stored only in Vercel's server environment. |

None of these variables need a `VITE_` prefix. Authentication runs on the server; no Google secret, database password, or Google access/refresh token is stored in browser JavaScript. Never commit actual environment values.

The first API request applies the SQL files in `server/migrations` atomically. A transaction-level advisory lock serializes concurrent cold starts, and the migration ledger skips already-applied versions. Configure a **dedicated** database: the app uses its own tables in `public`. Do not separately create tables or copy a schema from another gtfol app. Hosted startup requires `DATABASE_URL`; it will never silently create an ephemeral local database. Supabase connections require certificate-verified TLS.

### Google sign-in

1. Create a Google OAuth **Web application** client, or add Asset's callback to your existing gtfol client. Set the authorized JavaScript origin to `https://asset.gtfol.dev` and the authorized redirect URI to **`https://asset.gtfol.dev/api/auth/callback/google`**. Asset requests only OpenID, email, and profile scopes.
2. Store the client ID and secret in Vercel using the variables above. No Supabase Auth provider, Supabase publishable key, or Supabase redirect configuration is required: Supabase provides PostgreSQL storage only.
3. For local development, add `http://localhost:4317/api/auth/callback/google` to Google's authorized redirect URIs. Add specific preview callbacks only when needed.
4. Redeploy after changing Vercel variables. Test Google sign-in, creating a manual account, refreshing, and signing out. A Google consent screen in Testing mode only admits its configured test users.

The server uses PKCE and a short-lived, HttpOnly `SameSite=Lax` state cookie for browser login. The resulting Asset session is HttpOnly, `SameSite=Strict`, and Secure over HTTPS. iOS uses the same Google browser flow, then exchanges a one-time callback code with its own PKCE proof for a Keychain-held session. No native Google secret is needed. Users map by their verified Google subject; an email collision with a legacy workspace requires explicit migration rather than automatic data transfer.

Manual accounts, CSV imports, and the synthetic demo need no Plaid credentials. Vercel requests and responses are limited to 4.5 MB; large workspaces/backups require the persistent service deployment until server-side paging is implemented. The transaction screen currently pages rendered rows, while the API transfers the complete workspace.

### Bank synchronization

The Vercel function does not run the continuous worker in `server/index.ts`. Keep `PLAID_WORKER_ENABLED=false` and leave bank credentials unset for the initial deployment. A persistent instance of the Node service can process the durable job queue against the same PostgreSQL database; only enable bank connections once that service, webhook delivery, and retry behavior have been verified. This release remains Plaid Sandbox-only.

See [Vercel's Node function documentation](https://vercel.com/docs/functions/runtimes/node-js), [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres), and [Google OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect).
