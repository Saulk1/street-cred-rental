# Rental advisor compute service

The chat's `compute_rental_advisor` tool executes the reviewed Python package in
`compute/world_model`. It replaces the historical rent-comparison calculator.
Historical source observations and the popup's independent manual comparison remain.
Saved legacy calculation records remain readable, but cannot execute the retired tool.

## Behavior

The advisor extracts explicit English or Chinese preferences, ranks a private
rental snapshot, asks up to two useful questions, and recommends up to three
homes with different tradeoffs. Users can answer with an option or custom text,
skip questions, add requirements, choose a home, reject one, or explain feedback.
Rejected homes remain excluded for that search; choosing a home or giving a reason
updates a belief over the soft weights (see Preference learning). Unknown features remain unknown.
No requirement is automatically relaxed. Ordinary property chat still uses live
Microburbs lookups and works independently of the advisor.

Ranking uses `ValueRanker`, a 60-candidate pool, and a question-value threshold
of three points. The demo FixedRanker is not used by the production adapter.
Walking distances use the supplied straight-line detour estimates and uncertainty
bands. Fair rent models asking prices, not signed leases. Snapshot listings are
not evidence of current availability. Heuristic priors and weights are not
calibrated satisfaction probabilities; source evaluation results are offline tests.

## Preference learning

`compute/world_model/preference.py` learns the four soft weights (value, groceries,
station, commute) from what the user picks.

- **Choice model.** Picking one of the homes shown is treated as a multinomial-logit
  choice over the ranker's own score components. The belief over weight multipliers
  and choice sharpness is a fixed, seeded set of 1,000 samples reweighted by the
  evidence. Saved state holds only the evidence (at most 30 entries, about 6 KB with
  the rest of the state), so the belief is reproducible and has no random state.
  The ranker uses the posterior mean, which for a linear score is the expected-utility ranking.
- **Which homes to show.** The first home is the ranker's top pick. The others are
  chosen greedily to maximise expected utility of selection: each must be clearly
  better under some weights that are still plausible, and within 15 points of the top pick.
  Role labels (lower rent, closer to a station, closer to your destination) are kept.
- **Skipped top pick.** If the user picks another home and the top pick still ranks
  first after the update, it is dropped only on the third such skip
  (`DEFAULT_SKIP_PATIENCE`). Skip counts and dropped homes are saved with the session.
  Homes the user explicitly rejects are still excluded immediately.

The previous fixed multipliers (x1.5, x2) remain available as `learner="heuristic"`,
and the fixed role picker as `selector="roles"`, for comparison.

`python scripts/eval-preference-learning.py --data <dir>` compares the options on
simulated users with hidden weights who pick noisily for six rounds. Regret is the
true score of the top recommendation minus the true score of that user's best home
(1 point is about 1% of rent). 500 users, seed 42; seed 7 gives the same order.

| Configuration | Start | After 6 picks | After 6 picks, unseen taste |
|---|---:|---:|---:|
| No learning | 1.67 | 1.67 | 3.11 |
| Before: fixed multipliers, fixed roles, drop on first skip | 1.67 | 2.98 | 3.49 |
| Fixed multipliers, fixed roles, drop on second skip | 1.67 | 1.86 | 2.93 |
| Belief, fixed roles, drop on second skip | 1.67 | 1.36 | 2.19 |
| Belief, EUS set, drop on first skip | 1.67 | 3.09 | 3.51 |
| **Default: belief, EUS set, drop on third skip** | 1.67 | **0.96** | **1.80** |
| Belief, EUS set, never drop | 1.67 | 0.48 | 1.56 |

Paired against the previous behaviour, the default lowers final regret by 2.02 ±0.38
points (1.69 ±0.46 with unseen taste). The EUS set also contains the user's true best
home far more often at the start: its regret is 0.09 against 0.69 for fixed roles.

What this does and does not show:

- Dropping the top pick on the first skip made six rounds of feedback worse than no
  learning at all, whichever learner was used. That rule, not the multipliers, was the main problem.
- "Never drop" scores best but can show the same top pick indefinitely to a user who
  keeps choosing something else, so the default keeps a bounded drop rule.
- Simulated users follow the same kind of choice rule the learner assumes. Their weights
  are not drawn from its prior, half ignore station distance entirely, and the unseen-taste
  column adds a per-home preference no feature explains, but this is still a simulation,
  not evidence about real renters. The gain shrinks as choices get noisier.
- After the first piece of feedback, station distance gets a small non-zero weight
  (about 2 to 3 points per kilometre) even if the user never mentioned stations.
- A session saved before this change keeps its old `weight_adjust` until the next
  feedback, which replaces it with the posterior mean.

## Private artifacts

Run `npm run rental:stage -- ./rental-world-model/data` after placing the supplied
folder in the repo, or pass any local directory containing `fair_rent_model.json`
and `for_rent_snapshot.json`. The staging script writes those two files and a
SHA-256 manifest to ignored `.private/rental/`. The imported source package lives
under `compute/`; the original `rental-world-model/` folder is ignored.

Private backend deployments explicitly include `.private/rental/*.json`. Stage
before deploying from the local working tree; a Git-only deployment must provide
these private files separately before packaging the Python function. Refreshing
requires staging a new matching model/snapshot and deploying together. No fitting,
network retrieval, or enrichment runs within a compute request. The Python worker
validates the manifest, hashes, dates and model version, then caches immutable
artifacts per warm worker. Missing or inconsistent files produce unavailable.
The runtime allowlist excludes all artifacts and Python code from both local and
public extension packages. Do not publish the original dataset or model JSON.

## Configuration and persistence

Set `COMPUTE_API_URL` to the exact HTTPS `/api/compute` URL and
`COMPUTE_SERVICE_TOKEN` to a separate random token of at least 32 printable ASCII
characters on both Node and Python. For local development only, the URL may be
`http://127.0.0.1:3001/api/compute`; use `npm run dev:compute` and `npm run dev:api`.
These settings never belong in the extension. Keep the existing chat/team settings.

Rental sessions use a separate server-only `COMPUTE_DATABASE_URL` with
SELECT/INSERT/UPDATE/DELETE on `rental_sessions` and `rental_events`.
The main data API and its health check continue to use `DATABASE_URL` from
`.env.local`. Neither connection falls back to the other. Run `npm run db:migrate:compute` to apply only the rental-table migrations
under `drizzle/compute/` to that connection. The main database keeps its existing
`npm run db:migrate` workflow. Builds and requests do not run migrations.
Migrations run only through the explicit migration command; deployment remains a separate step.

A random 256-bit capability in Chrome identifies each anonymous session. The
server stores only its hash. Sessions expire after 30 minutes of inactivity;
expired sessions and cascading events are pruned when a new session starts.
For physical deletion without traffic, schedule the equivalent expiry DELETE in
Neon. Requests cannot read expired sessions. New chat ends its session; failed
cleanup is handled by expiry. Browser storage holds the capability and pending
command, allowing a lost response to be retried with the same event ID.

Node owns authentication, database writes, optimistic revision checks and event
idempotency. Python receives one validated command and serialized state and
returns updated state plus display data. SQL commits state and event output in
one statement. Simulation changes only copies. Conflicting answers require resume;
stale question IDs cannot update the profile. A session pins its artifact version;
a deployment changing it asks the user to start a new search.

## Interfaces and bounds

- `POST /api/rental`: existing chat bearer authentication; JSON `{context, eventId,
  command}`. Context contains token and revision. Commands: start/message with text,
  resume, answer with questionId and optionId **or** text, feedback with chosenId,
  rejectedIds/reasons, and end. Responses contain revision and structured result,
  or `{ended:true}`. Errors use 400 validation, 401 authentication, 409 conflict or
  changed snapshot, 410 expired session, and 503 unavailable.
- `POST /api/chat`: optional rental context and stable user-message eventId.
  The model's advisor tool has no arguments: Node supplies the actual last user
  message. Results stream as `rental_result`, with no session capability included.
- `POST /api/compute`: separate service bearer token; versioned `rental_advisor`
  command, state, artifactVersion and deadlineMs. It accepts no caller-chosen paths,
  datasets, source code or import names. Retired calculator IDs are rejected.

Compute keeps the 8-second HTTP timeout and 64 KB input/output limits; the Python
platform maximum remains 10 seconds. Chat retains four model rounds, six tool
executions and 55 seconds, with five seconds reserved for explanation. One advisor
command needs one Python call and no live API fan-out. Node validates outputs
before committing. Errors retain only reviewed categories; diagnostics log
versions, action, reason, duration and revision without messages or capabilities.

## Verification

Run `npm run test:compute`, `npm run test:server`, `npm run test:ui`,
`npm run typecheck`, `npm run typecheck:server`, and `npm run test:package`.
To verify the configured compute database with a disposable session, run
`TEST_COMPUTE_DATABASE=1 npm run test:server -- tests/server/compute-database.integration.test.ts`.
For a live two-turn chat → Python HTTP → Neon verification, run
`TEST_LIVE_RENTAL_CHAT=1 npm run test:server -- tests/server/chat-live.integration.test.ts`.
It uses the configured OpenAI model, a temporary authenticated local compute service,
and one disposable session that is deleted afterward; private artifacts must be staged.
Source tests use synthetic fixtures. The private-artifact adapter smoke test skips
when artifacts are absent. Real Neon tests require explicit development settings. The isolated SQL test uses
`TEST_RENTAL_LOCAL_PG_PATH=/private/tmp/microburbs-rental-pg` with a disposable
PostgreSQL socket on port 55441 after applying the session migration. The local
HTTP test uses `TEST_COMPUTE_HTTP_URL=http://127.0.0.1:3001/api/compute` and the
fixed dummy token documented in its test; never use that token in a deployment.
Use `tests/fixtures/chat-preview.html?rental` for invented browser demonstration data.
The historical evaluation files under `reports/` describe the retired version;
they do not validate this advisor integration. `scripts/heldout-check.py` now runs
advisor acceptance checks without rewriting those historical reports.
