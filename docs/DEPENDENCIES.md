# Dependency and license review

Reviewed installed metadata and lockfiles on October 15–16, 2026. Direct JavaScript dependencies are pinned exactly; `apps/web/package-lock.json` pins transitive versions and integrity hashes. Swift Package Manager pins Plaid LinkKit 7.2.2, revision `3aff12979f81daab780628d7442a1b3f8e7eefc6`. Run `npm ci` in `apps/web` and use the checked-in Swift package resolution in `apps/ios` to reproduce the builds.

| Component | Version | Declared license / role |
| --- | --- | --- |
| React, React DOM | 19.3.1 | MIT; web UI |
| Express | 5.3.0 | MIT; API/server |
| PGlite | 0.5.10 | Apache-2.0; embedded PostgreSQL |
| pg | 8.23.1 | MIT; optional hosted PostgreSQL |
| jose | 6.2.12 | MIT; Google ID-token and signed webhook verification |
| @vercel/functions | 3.10.1 | Apache-2.0; hosted database pool lifecycle |
| Svix | 2.8.0 | MIT; inbound webhook signature and timestamp verification |
| html-to-text | 10.0.1 | MIT; bounded plain-text receipt extraction |
| Papa Parse | 5.7.0 | MIT; CSV parser |
| Zod | 4.6.7 | MIT; shared schema validation |
| Lucide React | 1.57.0 | ISC; icons |
| react-plaid-link | 5.0.0 | MIT; official web Link wrapper |
| tsx | 4.23.15 | MIT; backend TypeScript runtime |
| Vite / React plugin | 8.3.4 / 6.1.2 | MIT; web build |
| TypeScript | 7.0.2 | Apache-2.0; type checking |
| esbuild | 0.28.2 | MIT; shared iOS calculation bundle |
| Vitest | 5.0.4 | MIT; test runner |
| Prettier | 3.9.10 | MIT; formatting |
| `@types/*` | Lockfile versions | MIT; development type declarations |
| Plaid iOS SPM wrapper | 7.2.2 | MIT wrapper; binary LinkKit/service terms remain separate |
| Lato regular and medium | Bundled font files | SIL Open Font License 1.1; unmodified, offline fonts |

The full lockfile has MIT, ISC, Apache-2.0, BSD-3-Clause, and MPL-2.0 declarations. MPL entries are Lightning CSS and its platform binaries used by the development build toolchain; no modified Lightning CSS source is included. No dependency has an unspecified license in the lockfile. Preserve upstream notices when redistributing bundles. The generated [third-party notices](../apps/web/public/third-party-notices.txt) collect installed package license files and the font notice; platform packages not installed on this machine remain governed by their upstream licenses.

`npm audit` reported **0 vulnerabilities** (220 dependency entries) on 2026-10-15. This is a point-in-time registry check, not a security certification. Repeat it and review release changes before upgrades or deployment. No dependencies are fetched by the app at runtime except the official Plaid Link experience when requested.

Lato is sourced from the official Google Fonts distribution. Its [OFL notice](../apps/web/public/fonts/OFL.txt) is bundled with the web and native app. Copilot screenshots are linked as research references only, not shipped as product assets. The private `gtfol/ai` design standard is not copied into the repository.

The project MIT license is **proposed**, not silently finalized: see [LICENSE.proposed](../LICENSE.proposed). Plaid service access, Apple distribution/signing, and deployment terms require the owner's separate choices. No third-party service agreement has been accepted on the owner's behalf.
