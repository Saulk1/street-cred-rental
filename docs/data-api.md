# Data API: Neon, Drizzle and Vercel

The extension will query a public, read-only HTTPS API hosted on Vercel. That API
uses Drizzle ORM and the Neon HTTP driver to query PostgreSQL. Database connection
strings stay on the server. The existing Microburbs API remains independent.

The 9,143 energy and emissions records in `assets/example.csv` have been imported
into `energy_reports`. The Drizzle schema and generated migration are included.
Dataset query routes and extension UI are deferred. The import uses native
PostgreSQL tools; there is no custom import or migration runner or upload endpoint.

## Install and configure

Use Node.js 22.12+ and `npm ci`. Add `DATABASE_URL` to the existing `.env.local`,
preserving its other settings. Add `DATABASE_MIGRATION_URL` separately when
migrations are needed. This file is ignored by Git and excluded from deployment.
The CLI commands below load it with Node's
native env-file support; already-exported environment variables take precedence.

| Variable | Purpose | Where to set it |
| --- | --- | --- |
| `DATABASE_URL` | Neon connection for a restricted runtime role | `.env.local`; Vercel Development, Preview and Production settings as appropriate |
| `DATABASE_MIGRATION_URL` | Direct Neon connection for the database owner | `.env.local` or the operator's shell only |
| `TEST_DATABASE_URL` | Explicit opt-in connection to a development branch for integration tests | Operator's shell or `.env.local` |
| `TEST_ENERGY_REPORTS` | Set to `1` to verify the imported dataset through Drizzle | Operator's shell or `.env.local` |
| `DATA_API_BASE_URL` | Public deployed HTTPS origin, without a path | Extension's existing `.env.local` only |

Never use a `VITE_` prefix for database credentials. Do not put database credentials
in extension runtime configuration. The packager copies only the explicitly
allowed extension settings from `.env.local`; database variables remain local
and are excluded from the generated package.

## Set up Neon

1. Create a Neon project and a production database. Select a region close to
   your Vercel functions and set the Vercel function region accordingly.
2. Create a development child branch. Local development and Vercel Preview must
   use that branch, rather than the production connection string.
3. Create a restricted login role named `data_api_reader` through SQL or the
   Neon CLI's explicit read-only access option. Ordinary roles created through
   the Neon Console/API may be administrators; see [Neon role guidance](https://neon.com/docs/manage/roles).
   Grant this role CONNECT to the application database and USAGE on the dataset
   schema. Once tables exist, grant SELECT only on the intended public dataset
   tables. Do not grant writes, schema creation, migration ownership or access to
   Drizzle's migration bookkeeping. A fresh restricted role can run `SELECT 1`
   before dataset tables exist.
4. Set `DATABASE_URL` to that role's SSL-enabled Neon connection string on the
   development branch. Use the direct SSL-enabled owner connection for
   `DATABASE_MIGRATION_URL`. The runtime never falls back to the migration URL.
5. Repeat the role/grant setup as needed for production. Branches copied before
   role or permission changes need to be checked independently.

## Local API development

Run `npm run dev:api`. On first use, the Vercel CLI requires login and linking
to a project; select the repository root and the **Other** framework preset.
The checked-in configuration disables Vite framework detection and builds only
the server type check. It does not run the extension build. Configure deployed
server environment variables in the Vercel dashboard. The local CLI reads
`.env.local`; generated extension settings never include database variables.

Call `curl -i http://localhost:3000/api/health`.

| Request/result | Response |
| --- | --- |
| GET, database reachable | HTTP 200, `{"status":"ok"}` |
| GET, missing configuration or database failure | HTTP 503, `{"status":"unavailable"}` |
| Any other method | HTTP 405, `Allow: GET` |

Health responses use `Cache-Control: no-store`. GET runs `SELECT 1` through
Drizzle with a five-second HTTP timeout. Errors do not return or log database
connection details. No frontend CORS setup is needed for future extension
service-worker requests using explicit host permissions; browser-page access is
not an interface provided by this milestone.

## Schema and migrations

The schema module at `server/db/schema.ts` defines `energyReports`, mapping to
PostgreSQL's `energy_reports`. Its exported `EnergyReport` and `NewEnergyReport`
types support typed reads and inserts. `drizzle/0000_energy_reports.sql` and its
generated snapshot/journal create the table, checks and index.

For subsequent schema changes:

1. Update the schema module based on the new data and intended queries.
2. Run `npm run db:generate`, inspect the generated SQL and snapshots, and commit
   them together. Generation is local and does not need database credentials.
3. Set `DATABASE_MIGRATION_URL` to the development branch's owner connection,
   then run `npm run db:migrate`. This command requires migration credentials;
   it never uses the restricted runtime URL.
4. Validate on development, then explicitly target production and apply the
   same reviewed migration files. Builds and HTTP requests never run migrations.

These commands use [Drizzle Kit's migration workflow](https://orm.drizzle.team/docs/drizzle-kit-migrate),
without a custom migration script. Keep credentials out of committed migration
files. The initial migration was applied to the supplied Neon project using its
existing admin connection explicitly as `DATABASE_MIGRATION_URL` for that command;
no migration credential was persisted or added to the runtime fallback logic.

## Deploy the API

1. Import the repository into Vercel, or use `npx vercel` after login. Keep the
   root directory as the repository root and select **Other**. Node 22.x is a
   supported choice for this project.
2. Configure `DATABASE_URL` separately for Development/Preview and Production.
   Only the restricted runtime credential belongs in the deployed API. Do not
   configure `DATABASE_MIGRATION_URL` on Vercel.
3. Verify the preview health endpoint against the development Neon branch.
   Promote with Vercel's dashboard or `npx vercel --prod` when ready. Production
   must be publicly reachable for extension requests; preview deployment
   protection may require authentication for manual checks.
4. Before public use, configure a Vercel Firewall rate-limit rule for `/api/*`
   at 60 requests per minute per IP, returning HTTP 429. Check feature availability
   and cost in your Vercel plan. No in-memory counter is used across functions.
5. Confirm `/api/health` returns HTTP 200, and paths such as `/manifest.json`,
   `/background.js`, `/runtime-config.js`, `/.env.local` and dataset CSV
   paths return HTTP 404. Watch HTTP 503 counts in Vercel request metrics.

Vercel's [function runtime](https://vercel.com/docs/functions/runtimes/node-js)
builds the API entrypoint. `server/public/` is intentionally empty and is the only
static output directory. `.vercelignore` allowlists server/configuration inputs
and excludes raw CSVs and local environment files. Extension build artifacts
are never published as website assets.

## Configure the extension

Add `DATA_API_BASE_URL=https://your-project.vercel.app` to the existing
`.env.local`, preserving its Microburbs settings. Rebuild with
`python3 scripts/package.py`, reload `dist/unpacked/` in Chrome, and refresh open
webpages as usual.

The builder adds only that exact HTTPS origin to the generated manifest's
connection policy and host permissions. It emits the public URL as
`globalThis.DATA_API_CONFIG.baseUrl`, separate from `MICROBURBS_CONFIG`. Leaving
the setting empty adds no permissions. This milestone makes no automatic data
API requests and adds no worker messages or UI. HTTP localhost origins are not
allowed in extension packages; use curl for local API checks.

## Verify

```sh
npm run typecheck
npm run typecheck:server
npm run test:server
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p '*_test.py'
npm run test:package
```

The live integration test is skipped unless `TEST_DATABASE_URL` is set. To run
it against a development branch, put that variable in `.env.local` and
run:

```sh
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run --config vitest.server.config.mts
```

Set `TEST_ENERGY_REPORTS=1` as well to check the 9,143-row dataset, including exact
negative decimals, zero measures and missing values. That test requires the schema
and CSV to have been loaded on the target branch. Tests perform reads only.

## Imported CSV

Imported on 2026-11-07 from `assets/example.csv`:

- Source SHA-256: `d5aee969bbc279ca49c2c066fb60849e6a7a7f3cd054c0ce68cdf9cc0954c838`.
- 9,143 rows, 12 columns, unique source `id` values; years 1990–2026.
- 11 report categories and 10 region codes. No addresses or property identifiers
  are present, so no relationship to the property lookup has been invented.
- `id` is the primary key, `year` is an integer, `fy` preserves the source label,
  and nullable `report_date` uses PostgreSQL `date` / Drizzle string mode.
- `co2`, `co2_scope1`, `co2_scope2`, `mwh` and `gj` use unconstrained PostgreSQL
  `numeric`, returned by Drizzle as strings. This preserves exact decimals and
  valid negative values. Measurement units are not inferred from the data.
- Literal `NULL` values become SQL nulls; zero remains a value. Required fields
  and fiscal-year format have database checks. The fiscal year is not inferred
  from `year`, because the supplied rows do not consistently share that rule.
- The composite index supports filtering by code, category and year. There are
  no foreign keys until another dataset with a real relationship is supplied.

The one-time import validated all headers, unique IDs, required text, dates and
finite numeric values before writing. It used native `psql` with `ON_ERROR_STOP`
and a single transaction: create a temporary table with the target constraints,
bulk-load using `\copy` with `HEADER MATCH` and `NULL 'NULL'`, check the 9,143-row
count, insert with `ON CONFLICT (id) DO NOTHING`, then compare all source rows to
the destination with `EXCEPT` before committing. Conflicting existing records
cause the entire transaction to roll back rather than being silently overwritten.

The import was repeated: the first run inserted 9,143 rows; the second inserted
zero. Both ended with 9,143 rows. A complete export was compared to the source:
all 12 fields in every row matched, with decimal values compared exactly. The
live Drizzle dataset and health tests passed along with the backend unit tests
(14 tests total). CSV and database credentials remain excluded from Vercel
deployment and extension packaging. No dataset API or UI was added.
