# Property assistant

Production backend: `https://microburbs-facts.vercel.app`.
Set this exact origin as `DATA_API_BASE_URL` in the local extension configuration.
The `microburbs/microburbs-facts` Vercel project uses Node.js 22, production
server environment variables and a published 10-request/60-second per-IP limit
for `POST /api/chat`.

The extension's options page is a dedicated property chatbot with the supplied
Microburbs logo and shadcn conversation primitives. It retains streaming, saved
conversations, keyboard submission and expandable calculation details. Rental
questions and answer controls appear inside the scrolling conversation; only the
latest rental result has active controls. Reopening restores a pending question
in place. The previous guide remains on the welcome page and side panel.

## Configure a private team build

Install dependencies with `npm ci`. Add these settings to the existing root
`.env.local`, preserving its other values:

| Setting | Usage |
| --- | --- |
| `OPENAI_API_KEY` | Server only: your OpenAI project API key |
| `OPENAI_MODEL` | Server only: a model available to your project that supports Responses API function calling; required, with no automatic fallback |
| `OPENAI_REASONING_EFFORT` | Server only: optional `none`, `low`, `medium`, `high`, `xhigh` or `max`; configure a value supported by the chosen model. The local Luna configuration uses `gpt-6-luna` and `medium`. |
| `CHAT_ACCESS_TOKEN` | Same team bearer token on the backend and in the private extension build |
| `MICROBURBS_API_BASE_URL` | Existing HTTPS Microburbs API origin, also used by server tools |
| `MICROBURBS_API_KEY` | Existing Microburbs team key, also used by server tools |
| `DATA_API_BASE_URL` | Public HTTPS origin of the deployed chat backend, without a path |

Generate a strong team token with `openssl rand -hex 32` and save it locally.
The server reads `.env.local` through the shared loader. Exported/deployed
environment variables take precedence. No secret values are printed by the
packager. Never use `VITE_` variables for provider keys or database credentials.

On Vercel, configure `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, `CHAT_ACCESS_TOKEN` and
the two Microburbs settings for the intended environment. Uploading `.env.local`
is unnecessary and excluded. This implementation does not deploy automatically.
Keep the provider key restricted to a dedicated OpenAI project with an appropriate
spend limit.

Before hosted use, add a Vercel Firewall rate-limit rule matching the exact path
`/api/chat` and method `POST`: 10 requests per 60 seconds per source IP, with a
429 response when exceeded. This is a deployment setting, not an in-memory
server counter. Confirm the rule is active for the intended deployment. Shared
team-token authentication is designed for a private prototype, not public users.

Run `python3 scripts/package.py`, reload `dist/unpacked/` in Chrome, and reopen
Options. The packager generates chat configuration from `DATA_API_BASE_URL` and
`CHAT_ACCESS_TOKEN`, using only that exact origin in host permissions and CSP.
Provider keys and database credentials are excluded from all extension files.
The private output contains an inspectable team token, so do not share or commit
it. Rebuild after rotating the token on the server.

Run `python3 scripts/package.py --public` for a separate public distribution in
`dist/public/`. It omits both the Microburbs key and chat token. Chat shows an
unavailable state and makes no requests in that build.

## Use the chat

Ask a question about a full address in the City of Sydney. The assistant can
search addresses and retrieve basics, model valuations, risks, sale/rent history,
planning, schools, amenities and transport. It asks for clarification when
addresses are ambiguous. Retrieved sources appear below each answer and are
referenced as `[S1]`, `[S2]`, and so on, separately for each answer.

The assistant also supports a Python rental advisor: ask for rentals with a budget,
area, bedroom count and any requirements. A dated private snapshot supplies up to
three recommendations. Use its question options, custom answers and feedback to
refine the search. Anonymous preferences persist in Neon for the session; the
browser keeps its capability. See [Rental advisor setup](property-compute.md).
The advisor asks up to two questions when a preference could materially change
the result; sufficiently clear searches may receive recommendations immediately.

Enter sends a message; Shift+Enter inserts a newline. IME composition does not
send a message. Stop cancels the current request. Interrupted or failed replies
remain marked incomplete, can be retried, and are excluded from future model
context. New chat cancels pending work, clears this chat's local thread and ends its rental session.
Closing or reloading the page preserves the conversation; reopening never resumes
an old model request. Draft text is not saved.

Messages and requested property data travel to the backend and OpenAI. Notes and
webpage content are not included. OpenAI response storage is disabled with
`store: false`; this is not a claim about the provider's other retention policies.
The application backend stores no conversation in its database. The local thread
uses `property-chat:v1` in Chrome local storage, capped at 80 displayed messages.
Only the most recent complete messages fitting the request limits are sent again.

The assistant uses fixed read-only endpoints. It cannot access arbitrary URLs,
files, saved notes, database datasets or write tools. A valuation is an estimate,
and overlays do not replace a planning certificate. Answers may still contain
model errors; verify significant facts against the cited property data.

## API contract and limits

`POST /api/chat` requires `Authorization: Bearer <team token>` and JSON:

```json
{"messages":[{"role":"user","content":"What is near 26 Tudor Street, Surry Hills?"}]}
```

Only user and assistant text messages are accepted. The last must be a user
message. Limits are 40 messages, 4,000 characters each, 64,000 total characters
and a 300,000-byte encoded body. System instructions, tools, model selection and
credentials are server-controlled.

The response is `application/x-ndjson`, one event per line:

```json
{"type":"tool","id":"call-id","label":"Searching addresses","status":"running"}
{"type":"source","source":{"id":"S1","label":"Address matches","path":"/v1/geocode/address?address=..."}}
{"type":"delta","text":"Here is the answer..."}
{"type":"done"}
```

Tool statuses are `running`, `done` and `error`. A stream failure ends with
`{"type":"error","code":"upstream","message":"..."}` instead of `done`.
Transport EOF without `done` means an incomplete answer. Before streaming,
authentication, validation and configuration errors use HTTP 401, 400 and 503
respectively; unsupported methods use 405. All responses use `Cache-Control:
no-store` and include `X-Request-Id`.

Each turn allows four model rounds and six tool executions. A details tool can
make three endpoint requests. Property requests are serialized at least 125ms
apart within a turn, with a 20-second request timeout; Retry-After stops further
lookups during the wait. Concurrent turns share upstream API limits. There are
no automatic model retries. The overall deadline is 55 seconds; Vercel's chat
function maximum duration is 60 seconds. Output is limited to 4,000 characters
and 2,000 model output tokens per round. Cancellation propagates to both services.

Server logs contain only request IDs, duration and completion/error categories.
Use those IDs to investigate failures; do not add prompt or credential logging.

## Verification

Run `npm run test:ui`, `npm run test:server`, `npm run typecheck`,
`npm run typecheck:server`, `node --test tests/*.test.mjs` and
`python3 -m unittest discover -s tests -p '*_test.py'`.
Run `npm run test:package` and `npm run test:package -- --public` to verify both
distributions, including the runtime allowlist, origins and CSP.

After `npm run build`, open `tests/fixtures/chat-preview.html` in Chrome for a
fixture-only visual check. It uses invented data, dummy settings, browser session
storage and mocked fetch; it does not contact any service. Add `?unavailable` to
check missing configuration. Automated tests mock both upstream services. A live
smoke test requires the configured backend and actual credentials and is separate
from these deterministic checks.
