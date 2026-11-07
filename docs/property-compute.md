# Python calculations in property chat

The options chatbot can call reviewed Python calculators using Microburbs data
and explicit user responses. The first calculator, `rent_comparison` version
`1.0.0`, compares a proposed weekly rent with the property's **latest historical
asking rent**. The API does not specify that historical amount's rent period,
so the user must confirm it. It does not estimate today's market rent.

Example: “Compare $750 per week for 26 Tudor Street, Surry Hills. The historical
listing amount is weekly.” Search resolves
the address, the chat server retrieves `/rent-history-latest`, and Python computes
the weekly difference, 52-week annual difference and percentage difference. If
the proposed weekly amount or historical listing period is missing, the chatbot
asks for it. Historical amounts can be weekly, fortnightly, monthly or yearly;
conversions use 52 weeks, 26 fortnights or 12 months per year. Missing or invalid API
rent is reported as unavailable, never substituted with zero or example data.

## Flow and boundaries

`src/chat.tsx` → `POST /api/chat` → named `compute_*` tool → `server/compute.ts`
→ existing `server/property.ts` client → `POST /api/compute` → reviewed Python
module → structured calculation event → chatbot explanation.

The model chooses a registered tool and supplies numeric or enumerated user parameters with an
exact quote and zero-based index of the supporting user message in that request.
The server checks the quote contains the supplied number or a recognized term
for the selected enum value and comes from a user,
not an assistant. This verifies literal support, not the semantic meaning of the
quote; instructions require clarification for unclear units or conflicting values.
Only necessary validated parameters and normalized API fields go to Python, not
the whole conversation or any provider/API credentials.

The server fetches API values itself. Tool schemas accept no API values, file
paths, URLs or source code. The existing per-turn address search guard applies
to data retrieval, including calculations. A calculation fetch uses the same
125ms API spacing and Retry-After handling. Successful reads are deduplicated
within the turn and receive source IDs and retrieval timestamps.

Only the latest single rental record is needed for this first calculator; no
truncated arrays are used. The current chat property client caps some list
datasets at 50 rows. Any future aggregate calculator must add a dedicated adapter
with pagination and explicit completeness checks before using those lists.

Calculation records (`C1`, etc., separately numbered per assistant answer) hold
the calculator/version, property ID, exact user input and quote, API input
snapshot/source IDs/timestamps, metrics with units, assumptions and limitations.
The UI validates and renders these through expandable Trace rows. They survive
reopening the chat. The existing `property-chat:v1` key is extended additively:
older messages lacking `calculations` load with an empty array. New requests still
send only complete user/assistant text; stored results are not trusted as fresh
API facts in later turns. New chat removes the records with the conversation.

## Configuration

Server-only variables, supplied to the backend deployment:

| Variable | Value |
| --- | --- |
| `COMPUTE_API_URL` | Exact deployed HTTPS URL ending `/api/compute`, e.g. `https://microburbs-facts.vercel.app/api/compute` |
| `COMPUTE_SERVICE_TOKEN` | A separate random token, at least 32 printable non-whitespace ASCII characters; use the same value for the Node and Python functions |

Generate a token with `openssl rand -hex 32`. Do not reuse the extension's team
token. These settings never belong in extension runtime configuration. Compute
is optional: missing settings leave ordinary chat/property lookups working and
produce a clear error only when a calculation is requested.

The existing file-based Vercel project deploys `api/compute.py` using Python 3.12
and a standard-library HTTP handler. There are no additional Python packages.
`pyproject.toml` pins the Python minor version. No Python framework preset is
introduced, preserving the existing TypeScript API routes. `.vercelignore`
includes the calculator package and excludes local secrets, datasets and bytecode.
The extension packager's explicit runtime allowlist excludes all Python sources,
contracts and server credentials.

For local development, add the variables to `.env.local`, using
`COMPUTE_API_URL=http://127.0.0.1:3001/api/compute`, then run `npm run dev:compute`
and `npm run dev:api` in separate terminals. The development launcher loads the
same dotenv file as the Node server. Plain HTTP is accepted only for loopback
outside production. Deploy and configure both functions together so their
calculator versions match. Restrict the compute route to POST and apply an
appropriate deployment rate limit alongside the existing chat rule.

## Execution limits

The chat retains four model rounds, six tool executions and a 55-second overall
deadline. Search → compute → explanation needs three rounds. The compute tool
requests only its declared API datasets and reserves at least five seconds for
the final explanation. Calls to Python have an eight-second maximum timeout,
64 KB response limit, no redirects and no retries. The Python function has a
10-second platform maximum and checks the supplied deadline before and after
execution; longer algorithms must check their context deadline periodically.

Stop/disconnect propagates to the Node compute HTTP request. Aborting HTTP does
not guarantee immediate termination of remote CPU work: Python enforces its own
deadline, backed by the platform maximum. Keep modules bounded, deterministic
and free of network/file writes. Longer work needs a separate job/status design.

## Add another calculator

1. Add `compute/calculators/<name>.py` exposing
   `calculate(inputs, datasets, context)`; return `status`, `metrics`,
   `assumptions` and `warnings`, or an explicit `unavailable` result.
2. Add its descriptor to `compute/catalog.json`: ID, version, description,
   numeric user-input fields/ranges/units or enum options/evidence terms,
   required datasets and exact ordered output metrics. The first implementation
   supports numeric and enumerated user parameters
   and small flat record datasets. Extend both boundary validators if new
   types or dataset shapes are needed.
3. Statically import and register the function in `compute/registry.py`.
   Filenames/import paths never come from callers. Node builds strict model-tool
   schemas from the catalog, avoiding a second handwritten tool definition.
4. Add numerical fixtures and adapter tests; document completeness, units,
   rounding and assumptions. Bump the version whenever formulas or contracts
   change. Deploy the Node and Python functions together.

Tests: `npm run test:compute`, `npm run test:server -- tests/server/compute.test.ts
tests/server/chat.test.ts tests/server/property.test.ts`, and `npm run test:ui --
tests/ui/chat.test.tsx tests/ui/chat-client.test.tsx`. Server tests run real Python
with dummy API fixtures; no external services or credentials are required.

The browser fixture at `tests/fixtures/chat-preview.html?compute` displays invented
calculation data for visual/keyboard verification. It never calls a live service.
