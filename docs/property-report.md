# Toolbar property reports

Confirm an address in the page selection card, then open the toolbar popup.
Its default Property tab shows the last confirmed match across all browser tabs.
Notes remain available in a separate tab. Merely highlighting text does not start
a report; ambiguous searches wait until a matching candidate is chosen.

The popup follows the Rental and Buy reference layouts. Rental shows the latest
advertised weekly rent, an optional comparison with a manually entered asking
rent, and nearby transport and amenities. An advertised rent is an observation,
not a model estimate. Buy shows the automated valuation and its 80% range,
comparable sales, primary zoning and flood/bushfire overlays. Missing fields are
shown as unavailable; no wellbeing score, noise rating, greenery measurement or
development applications are invented. For-sale listings are labelled separately
from sold records.

**Save to notes** saves the confirmed address. **Share this home** copies that
address to the clipboard and reports whether copying succeeded. **Change** explains
how to confirm another address on a webpage. The asking-rent input survives
switching between Rental, Buy and Notes during the current popup session.
**Sources & full property report** expands the complete endpoint browser, refresh
control, coverage information and downloads. Summary cards read saved envelopes;
they do not initiate duplicate upstream requests.
The Rental/Buy overview uses the saved data; expand **Sources & full property
report** for request progress, refresh, every endpoint and complete responses.

The worker fetches every property data endpoint in the checked-in API contract,
then uses the property profile's exact identifiers for suburb, mesh-block, LGA,
SA4 and area-statistics datasets. The registry accounts for all 176 API paths,
including supporting discovery/account paths that are not per-address datasets.
It does not recursively research returned neighbours or request unrelated regions.
The report does not use the Neon datasets or send results to the chatbot.

All six hazard layers and supported GeoJSON/counts/verbose flags are included.
All returned statistic field codes are requested in groups of five for the known
SAL, SA1–SA4, LGA, postcode, GCCSA and state identifiers. The field catalog itself
has a documented maximum of 500; an advertised larger count is labelled as capped.
Documented limit/offset pagination follows returned totals or next offsets. Other
query parameters retain their documented defaults. No endpoint can promise more
records than its upstream API exposes; endpoint documentation, availability
metadata and complete responses remain accessible in each section.

Results appear progressively; opening a section does not initiate its API fetch.
Records render ten at a time, deeply nested data stays collapsed, and full JSON
is displayed in 10,000-character chunks. Downloads preserve the complete response;
direct Feature/FeatureCollection payloads also have a GeoJSON download.

## Configuration and lifecycle

API traffic uses the existing shared worker client and the URL/key generated from
the repository root `.env.local`. No report message accepts a request URL or path.
The popup is authorised by its exact extension URL; confirmation messages retain
the existing top-level HTTP(S) content-script sender checks.

The worker allows two report requests in flight, sharing the API client's 125 ms
start spacing and Retry-After gate with the selection card. A rate-limited task
gets up to three attempts; other failed endpoints offer explicit retry. An
authentication/configuration error pauses remaining work. Refresh retries the
whole report against the currently generated configuration.

IndexedDB holds complete envelopes, jobs and a 15-minute response cache keyed by
API origin and canonical endpoint path. Chrome local storage holds only the small
current-report summary. Refresh bypasses cached responses; selecting another
address discards obsolete queued work and ignores old job completions. Cache
entries older than 15 minutes are pruned when a new report starts.

Work runs in batches that stop starting requests after 20 seconds, with each
request retaining the client's 20-second timeout. Pending work persists before
requests start, so a terminated worker can retry safely. While the popup is open
it requests successive batches; otherwise a one-minute Chrome alarm resumes work.
The alarm is recreated on worker startup if a running report exists, and cleared
on completion or pause. This supports Chrome 116 without relying on newer alarm
intervals or indefinite worker keepalive. Browser shutdown/sleep delays progress.

Storage errors are shown without including credentials or internal exceptions.
Full-report traffic can involve many requests and large geographic payloads;
progress totals grow as pagination and statistic-field batches are discovered.

## Validation

Run `node --test tests/*.test.mjs`, `npm run test:ui`, `npm run typecheck`, and
`npm run test:package`. Tests use dummy credentials and mocked API responses.
Build with `python3 scripts/package.py`; reload `dist/unpacked/` in Chrome and
refresh existing webpages to load the updated selection card. The extension
requests the additional `alarms` permission; host permissions remain restricted
to the configured origins. Public packages intentionally omit API keys.
