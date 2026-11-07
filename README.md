# Microburbs Facts

**Beta extension for the Microburbs Hackathon 2026, built by team Street Cred.**

Research a home while browsing its listing. Highlight an address, confirm the
match, explore Rental and Buy views, and ask a property assistant follow-up
questions backed by Microburbs data and inspectable Python calculations.

## What we built

Microburbs Facts is a Chrome extension with three connected tools:

- **Property research:** an on-page address lookup and a toolbar popup with
  rental history, automated valuations, comparable sales, amenities, zoning,
  environmental overlays and a suburb wellbeing index. A full report loads in
  the background and keeps its results when the popup closes.
- **Property assistant:** an options-page chatbot that retrieves property data,
  asks for missing information and streams answers with source references.
  Its Python rental advisor asks useful preference questions and recommends
  three rentals from a dated private snapshot, with fair asking-rent estimates.
- **Local notes:** save selected page text, property summaries or your own notes
  in the current Chrome profile.

The extension uses React and TypeScript. A Node.js backend coordinates the
chatbot's Microburbs lookups; a separate authenticated Python function runs
registered calculation modules.

## Who it helps

**Renters** can find rentals matching their preferences and explore
transport, shops and other everyday amenities. **Home buyers** can inspect
valuation estimates, nearby sales, zoning and mapped environmental context.
Both can keep their research together and ask follow-up questions without
manually combining API responses or doing the arithmetic themselves.

Current property-data coverage is the **City of Sydney LGA**. Valuations are
estimates, historical listings are dated observations, and overlays provide
context rather than a planning certificate.

## The data

- **Microburbs Hackathon API:** address matching, property facts, valuations,
  sale and rental history, comparables, planning, schools, amenities, transport,
  overlays and suburb/regional datasets. Missing values remain distinguishable
  from zero and from failed requests.
- **User responses:** explicit budgets, bedroom counts, areas, requirements and feedback.
- **Derived results:** a prototype suburb wellbeing average in the popup and
  rental recommendations from a private fitted asking-rent model and listing snapshot.

Notes, saved reports and conversation text stay in Chrome. Chat messages and
requested property data travel to the backend and OpenAI. Anonymous rental
preferences are also persisted in Neon with session expiry. The energy dataset
remains separate from property chat. Rental artifacts stay on the private backend.

## The clever step

**The chatbot explains; Python plans and ranks.** The rental advisor simulates
possible answers to decide which preference question would change the recommended
homes. It asks up to two questions, recommends three different tradeoffs, and
updates the search when the user answers or gives feedback. Source dates, fair
asking-rent estimates, walking-distance uncertainty and limitations remain visible.

## How to run it

Use **Node.js 22.12+ within the 22.x release**, **Python 3.12** and desktop Chrome.

1. Create a root `.env.local` with your team's `MICROBURBS_API_BASE_URL` and
   `MICROBURBS_API_KEY`. Preserve any existing settings.
2. Install dependencies and package the extension:

   ```sh
   npm ci
   python3 scripts/package.py
   ```

3. Open `chrome://extensions`, enable **Developer mode**, select **Load
   unpacked**, and choose `dist/unpacked/`. Pin Microburbs Facts.
4. On a webpage, select a full City of Sydney address and choose **Look up
   property**. Confirm the match, then open the toolbar popup for Rental and Buy
   views. Open **Options** for the property assistant.

To enable chat, deploy the backend with the server settings in
[Chat setup](docs/property-chat.md), then set `DATA_API_BASE_URL` to its HTTPS
origin and `CHAT_ACCESS_TOKEN` in the extension's `.env.local`. The rental advisor additionally needs staged private artifacts and Neon session
tables as described in [Compute setup](docs/property-compute.md), plus these **server-only** settings:

| Setting | Purpose |
| --- | --- |
| `COMPUTE_API_URL` | Exact HTTPS URL of the deployed `/api/compute` function |
| `COMPUTE_SERVICE_TOKEN` | A separate random token of at least 32 characters, shared by the Node and Python functions |

Rebuild with `python3 scripts/package.py`, reload the extension, and refresh
already-open webpages after changing source or extension settings. Provider
keys and compute credentials stay on the backend; local authenticated extension
builds contain inspectable team credentials and should remain private.

For backend development, use `npm run dev:api` and `npm run dev:compute` in
separate terminals, with `COMPUTE_API_URL=http://127.0.0.1:3001/api/compute` in
local settings. These local commands test the backend; the installed extension
requires an HTTPS chat origin. See [Compute setup](docs/property-compute.md) for
private artifact staging, session migration and the advisor contract.

Run `npm run test:compute`, `npm run test:server`, `npm run test:ui`,
`npm run typecheck` and `npm run typecheck:server` for the Python, backend and
chat UI checks. Core tests use fixtures; database integration checks are opt-in.

## Microburbs Hackathon 2026

The [Microburbs Hackathon 2026](https://www.microburbs.com.au/hackathon) is a free,
one-day build on **Saturday 7 November 2026**, held at UTS Business School in Sydney
and online across Australia, with Data Science Sydney. Teams of three to six use
Microburbs property and urban data for the City of Sydney to build apps, maps,
videos or other useful projects. Entries are judged on usefulness, clear
explanation and their ability to attract attention.

## Team Street Cred

This is the shared project repository for **Street Cred**. Thanks to the team
members building this hackathon entry together:

- Sibo (William) Zhang
- Nathan Li
- Himesha Patel

The extension is a beta prototype; its current functionality is described below.

## License

Released under the [MIT License](LICENSE). Copyright © 2026 Street Cred contributors.

## Install locally

### Optional Neon data API

The repository includes an optional Neon/Drizzle database layer with a typed
`energy_reports` schema. `GET /api/health` checks Neon connectivity. See
[Data API setup](docs/data-api.md) for database roles, environment configuration,
local development, deployment, migrations and import verification. Dataset query
endpoints and extension data views are deferred.

Set the optional `DATA_API_BASE_URL` in `.env.local` to prepare an extension build
for the deployed API. Database credentials belong only in the server environment;
the extension receives the public API origin. Existing Microburbs lookups work
independently.

### Extension installation

1. Create `.env.local` if it does not exist. Set `MICROBURBS_API_BASE_URL=https://api.microburbs.com.au` and `MICROBURBS_API_KEY` to your team's key. Keep existing local credentials when updating an installation.
2. With Node.js 22.12+ installed, run `npm ci`, then `python3 scripts/package.py` to generate the local runtime configuration, `dist/unpacked/` and the ZIP. An empty key is supported for development: notes work, and property lookups show setup guidance.
3. Open `chrome://extensions` in desktop Chrome and turn on **Developer mode**.
4. Click **Load unpacked** and choose **`dist/unpacked/`**, which contains the generated manifest.
5. Pin **Microburbs Facts** from Chrome's Extensions menu and click its icon.

Previously committed distributions contain no private API key and show setup
guidance until rebuilt locally. Local packaging writes the configured extension
to `dist/unpacked/` and embeds an inspectable copy of its key. Public packaging
writes a separate key-free distribution to `dist/public/`. Share that public
folder; keep `.env.local` and authenticated local output uncommitted.
The source `extension/runtime-config.js` is an empty source placeholder, never a place for keys.
The Python builder reads dotenv assignments without running shell code or expanding variables.

Every property lookup (address search, core details and additional sections) uses
the worker's shared API client and these generated settings. The optional backend
loads the same root `.env.local` before database access; deployed server variables
take precedence. Browser code never reads the dotenv file directly.

Chrome treats loading from a new folder as a separate unpacked installation.
If you previously loaded the repository root, its saved notes remain with that
installation; this feature does not migrate notes between extension identities.

Keep Developer mode on while using the unpacked extension; current Chrome disables
unpacked extensions when it is turned off.

On a fresh installation, a new active tab displays the extension icon and
the **A closer look at local** introduction Close the tab normally when finished. The greeting
does not reopen on extension reloads, updates, browser updates or browser restarts.
Uninstalling and reinstalling counts as a fresh installation and shows it again.
Existing users receiving an update do not see the welcome tab.

After editing source or `.env.local`, rebuild with `python3 scripts/package.py`,
click **Reload** on its card in `chrome://extensions`, and reopen the popup.
Reload existing webpages to refresh their content scripts. Run `npm ci` once after checkout, or when the lockfile changes. No development
server is needed for normal use.

If lookup still shows setup guidance after rebuilding, open the extension's
**Details** in `chrome://extensions` and check **Loaded from**. It must point to
`dist/unpacked/`; the repository root lacks the generated UI files and cannot
be loaded directly as an extension.
Disable the root installation before loading the generated folder to avoid
duplicate controls. Its saved notes remain in the disabled installation.

If lookup reports a configuration error, check the packager's **Property lookup**
status. Edit the root `.env.local`, then run `python3 scripts/package.py`, reload
the existing extension and refresh the webpage. Chrome reads generated
`runtime-config.js`, not dotenv files. The runtime settings, manifest host
permissions and `connect-src` must use the same API origins. Editing the generated
runtime file alone can leave requests blocked by the installed manifest.

Run `npm run test:package -- --check-only` to inspect the existing local output
without rebuilding it. This catches origin/policy mismatches and differences
between the unpacked files and ZIP. Lookup also reports configuration loading,
invalid settings and manifest mismatches before sending requests, without logging
keys. A public build deliberately omits the key and shows setup guidance.

### Selection card recovery

After a rebuild, reload the extension **and refresh any already-open webpages**.
Extension reloads invalidate content scripts that are still running in those
pages. The old controller now removes its card, cancels pending work and logs
once: **The extension was reloaded. Reload this webpage to restore the selection
card.** It cannot reconnect itself; refreshing the webpage loads a new controller.
The extension never refreshes webpages automatically or discards form input.

If the card still cannot open on a freshly loaded page, check the extension's
Errors view or the page console. Startup diagnostics identify the failing stage
and exception name without logging selected text, request payloads or keys.
Stylesheet failures identify the bundled-style loading stage and can be retried
after rebuilding/reloading. A property-lookup setup failure leaves **Save to notes**
available with an explanation. If native popover opening fails, the card switches
to its fixed-position fallback while keeping keyboard and dismissal behavior.

Use **Open options** in the popup to open or focus the options tab. You can also
right-click the extension's toolbar icon and choose **Options**. The page opens the property assistant, with streaming answers, Microburbs lookups and one locally saved conversation. See [Chat setup](docs/property-chat.md) to configure the private team build. Use **Open side panel** to open the guide in
the current browser window (Chrome 116 or newer).

The property assistant also supports a server-side Python rental advisor with
preference questions, three differentiated recommendations and fair asking-rent
estimates from a dated private snapshot. It requires staged private artifacts,
the new Neon session migration and compute credentials. See
[Rental advisor setup](docs/property-compute.md).

### Full property report

After confirming an address in the selection card, open the toolbar popup
for the Rental and Buy views. Rental shows the latest advertised
rent and nearby everyday amenities; Buy shows the valuation, comparable sales,
zoning and environmental overlays. Both views include a calculated suburb
wellbeing index with its five inputs and data coverage. **Sources & full property report** opens the
complete Microburbs report. All applicable property,
suburb and regional datasets load progressively, including histories, geographic
layers and area statistics. Reopening the popup restores progress and saved
results. Individual failures can be retried without losing successful results.
**Refresh report** requests fresh data; **Notes** keeps the existing notepad.
See [Toolbar property reports](docs/property-report.md) for coverage, API limits,
local caching and background recovery.

### Notepad

Type into **New note** and click **Save note**. Saved notes appear newest first
in the scrollable list below the editor. Each **Delete** button immediately removes
that note. Blank notes are rejected; line breaks and other entered text are
preserved. Notes are displayed as plain text, including saved URLs.

Right-click selected text and choose **Save selected text to notes**. The action
works while the popup is closed. Reopen it to see captured notes; an open popup
also refreshes when notes change. Previously saved URL notes remain readable and
deletable; the page-URL saving action has been removed.

On an ordinary HTTP or HTTPS page, select text with the mouse or keyboard to
show a **Save to notes** card beside the selection. Click it to save the selected
text, then open the toolbar popup to view or delete the note. The card confirms
success and blocks repeated saves until you make a new selection. If saving
fails, it offers a retry with the same captured text.

The selection card uses the popup's Microburbs logo, blue actions and rounded
white result cards. Property details and additional sections expand inside its
scrollable surface.

The card does not move focus when it appears. Press **Tab** to focus its Save
button and **Enter** or **Space** to activate it. **Escape**, clicking outside,
clearing the selection, scrolling or resizing dismisses the card; change the
selection to show it again. The card first tries the right side of the full
selection, then the left, with an 8px gap. If neither side fits, it appears below
all selected lines. When necessary, the page scrolls slightly to keep the address
and card visible together; temporary scroll space at the document bottom is
removed when the card closes. Tall results scroll inside the card. Selections
in inputs, textareas, editable content and embedded frames are
excluded. The existing right-click menu remains available independently.
Reload any already-open webpage after reloading the extension to use this feature.

### Property lookup

Select one full address on a regular webpage and click **Look up property** in
the selection card, or right-click the selected address and choose
**Look up property** from the extension's context menu. Either action opens
results in the same on-page card without saving a note. The context-menu action
supports non-editable text in the top-level HTTP/HTTPS page; it does not infer an
address from the page URL or content. If it cannot reach the card, the worker
logs guidance to reload the webpage and retry.
The worker sends only that address to the configured Microburbs Hackathon API.
It displays up to ten ranked address matches; choose one when there is more than
one. A single match loads automatically, with its matched address and GNAF ID
shown prominently. **Choose another match** returns to a multiple-match list.
Matching is not an exact-address guarantee. Include the unit number and suburb
when relevant. Coverage is limited to the **City of Sydney LGA**.

The expanded, scrollable card shows property type, bedrooms, bathrooms, covered
parking and indicative advertised land area; the automated valuation in AUD,
80% prediction interval, prediction date and model confidence; and property
overlays and nearby features. Missing values show **Not available**, distinct
from zero. Partial API failures retain other sections and offer retry.
Nearby overlays are distinguished from overlays at the address point. Power
lines and mobile black spots are proximity information; public-housing records
appear as neighbourhood context. These are model and overlay outputs, not a
formal appraisal or planning certificate.

Below the overview, expand any of five sections to load additional data:

- **Latest market activity:** the latest sale/listing and rental observations,
  with event type, month, price and address. A listing is not necessarily a
  completed sale, and rent has no assumed weekly or monthly period.
- **Zoning and planning:** published zone code, name, category and individual
  overlays, preserving their returned values and units.
- **Nearby schools:** school name, level, sector and straight-line distance,
  without implying catchment eligibility.
- **Nearby amenities:** supermarkets, green spaces and restaurants/cafés within
  1 km, separating API totals from the capped returned lists.
- **Nearby transport:** stop counts and the nearest train, tram, bus and ferry
  stop within 1 km, with straight-line distances rather than walking routes.

Several sections can stay open together. Each loads on first expansion and
keeps its result only for the current card and address match. Schools and amenity
categories initially show five returned rows; **Show more** reveals the rest
without another request. Errors have section-specific retries; sale and rental
observations retry independently. Existing overlays are also collapsible and
remain part of the initial request. Browser Find can reopen a loaded, collapsed
section containing a match.

Lookup is explicit and does not save a note. **Save to notes** remains independent.
Scrolling inside the card works normally; page scrolling, resizing and Escape
dismiss it. The worker times out individual API calls after 20 seconds, limits
request starts to eight per second across tabs, coalesces identical in-flight
requests and observes `Retry-After` before allowing rate-limit retries. It does
not persist property results or log keys and selected addresses.

Notes stay in this Chrome profile through extension reloads and browser restarts;
they are not synced or sent to a server. Uninstalling the extension removes them.
Drafts are saved only by clicking **Save note** and are lost when the popup closes.
A failed save preserves the open editor's text and allows retrying; a failed delete
retains the note. Context-menu failures are logged in the extension worker console
without the captured contents. Storage is subject to Chrome's local-storage quota.

To see the page widget, open an ordinary HTTP or HTTPS web page, then click
**Show page widget** in the popup. A **Microburbs Facts** card appears in the
bottom-right corner only after that click. Use its close button to hide it;
**Show page widget** opens it again without creating duplicates. Refreshing the
page or navigating to another page leaves the widget absent until another click.
If the page was open before installing or reloading the extension, reload the
page first. This also removes widgets created automatically by an older version.
The popup reports failures without leaving rejected promises unhandled.
Chrome protects some pages,
including browser settings and the Chrome Web Store, from content script injection.

## UI development and runtime files

The repository is organized by responsibility:

```text
extension/             Chrome extension source
  src/                 React/TypeScript entries, components, hooks and styles
  content-script/      Vanilla selection and widget lifecycle controllers
  assets/              Bundled brand image
  icons/               Chrome extension icons
  popup/, options/, sidepanel/, welcome/   Extension page shells
  manifest.json        Manifest template; worker and runtime modules sit beside it
api/                   Vercel HTTP entry points (Node.js and Python)
server/                Node.js services and Drizzle schemas
compute/               Python rental advisor and computation registry
shared/                Contracts shared by the extension and server
drizzle/               SQL migrations and metadata
data/                  Reference CSV datasets; never packaged or deployed
docs/                  Setup and feature documentation
  api/                 Microburbs OpenAPI specification
  media/               Pitch video, artwork and screenshots
  store/               Chrome Web Store listing and capture
reports/               Historical evaluation reports and their HTML viewer
tests/                 Controller, UI, server, Python and packaging checks
  fixtures/            Shared mock data, preview pages and world-model scenarios
scripts/               Build, packaging, verification and development commands
.build/                Ignored compiled intermediates
dist/                  Generated unpacked extensions and ZIPs
```

- `extension/src/`: React page/injected entries, typed view models, shared tokens and official
  shadcn components. `components.json` records the Nova/Radix/Lucide configuration.
- `extension/content-script/`: selection/widget lifecycle controllers and host-only CSS.
  React renders controls/results inside isolated shadow roots. Native popover and
  fixed-position fallback behavior are retained.
- `extension/background.js`, `extension/property-api.js`, `extension/consts.js`
  and `extension/report-*.js`: worker, API, message and report contracts.
- `@/` resolves to `extension/src/` in TypeScript, Vite, Vitest and shadcn.

`npm run build` creates local self-contained scripts and styles under `.build/`.
`python3 scripts/package.py` builds them and writes `dist/unpacked/` and the ZIP.
Load `dist/unpacked/` in Chrome; `extension/` contains uncompiled source.
The packager maps that source to the existing installed paths, so manifest URLs,
worker imports, storage keys and browser entry points remain stable.
The allowlist excludes TypeScript, source maps, npm dependencies, skills and tools.
Only bundled local assets run in Chrome, with the existing CSP and permissions.

The [historical report viewer](reports/report.html) lives beside its JSON evidence.
Recorded source paths and fingerprints in historical reports describe the files
at the time of the run. Presentation assets are in `docs/media/`, including
[the pitch video](docs/media/pitch.mp4).

For a mock-data property preview, run `npm run build`, serve the repository with
`python3 -m http.server 8766 --bind 127.0.0.1`, and open
`http://127.0.0.1:8766/tests/fixtures/property-preview.html`. The preview never
uses credentials or writes notes. For native selection behavior use the adjacent
`selection-card.html` fixture with the packaged extension loaded.


## Package

Run with Python 3 (standard library only):

```sh
python3 scripts/package.py
```

This default creates a private local build using the repository root `.env.local`.
It prints the absolute **Load unpacked** folder and whether both required
Microburbs settings are present. It never prints credentials. Missing settings
remain supported: notes work and lookup shows setup guidance.

To create and verify a public distribution:

```sh
python3 scripts/package.py --public
npm run test:package -- --public
```

The public mode clears only the generated Microburbs API key. It preserves the
API origins and `.env.local` itself, and leaves property lookup unconfigured in
the shared build. Its files are `dist/public/unpacked/` and
`dist/public/microburbs-facts-0.1.0.zip`. It never replaces `dist/unpacked/` or the
local ZIP. Share only `dist/public/`; the local runtime configuration and ZIP
contain credentials and must remain uncommitted.

Both verifiers check the runtime origins against exact manifest host permissions
and CSP connection sources, and compare every unpacked file with its ZIP entry.
To verify existing output without rebuilding, append `--check-only`, with
`--public` as well for the public folder.

The archive is `dist/microburbs-facts-0.1.0.zip`. Its manifest is at the ZIP root;
only runtime files and the MIT license are included. Documentation, skills,
source artwork, screenshots, the API YAML, tests, `.env.local` and packaging scripts
stay out of the upload. `runtime-config.js` and the API origin permissions/CSP are
generated in `dist/unpacked/`; the ZIP contains the same runtime bytes. Source
files are not rewritten by the build. The generated key is worker-only and is
not included in content scripts or web-accessible resources.

On 2026-11-07, both public and local builds passed package verification. After
reloading the existing `dist/unpacked/` installation in Chrome, selecting
**26 Tudor Street, Surry Hills** on the test fixture returned live address matches,
property facts and a valuation. No notes were added or deleted. The authenticated
local build was left in place.

The configuration repair was also checked in the existing Chrome installation:
the rebuilt origin matched its manifest policy and live lookup loaded the same
test property's facts and valuation. All 11 package tests and 72 worker/API/selection
tests passed. A separate public build left every local runtime file and ZIP byte
unchanged; both outputs passed `--check-only`. The root `.env.local` was unchanged.

## Modern Web Guidance tooling

The optional guidance workflow requires Node.js 22 or newer and the
[modern-web-guidance skill](https://github.com/GoogleChrome/modern-web-guidance)
installed at `.agents/skills/modern-web-guidance/`; its source is recorded in
`skills-lock.json`. Local skill files and cached tooling are excluded from Git.
Set up the CLI once using a locally cached copy of the official
`modern-web-guidance@0.0.197` package:

```sh
node scripts/modern-web-guidance.mjs setup
node scripts/modern-web-guidance.mjs search "respect text scaling"
node scripts/modern-web-guidance.mjs retrieve respect-os-text-scale
node scripts/modern-web-guidance.mjs list
```

Setup discovers npm's generated cache directories, validates the package identity,
version, guide files and bundled search assets, and copies the complete package
including its license and notices into `.tools/modern-web-guidance/`. It checks
the normal user cache even if `NPM_CONFIG_CACHE` points at an empty temporary cache.
For a custom cache location, set `NPM_CONFIG_CACHE` or use `setup --from` with the
package directory. Repeating setup reuses a complete installation. A missing or
incomplete copy can be repaired from the cache by running setup again.

The ignored `.tools/modern-web-guidance-install.json` records the installed version,
original source directory and setup time. Queries work offline, use that project
copy independently of npm cache cleanup, and never install or update anything.
The launcher disables CLI telemetry and file logging and reads the installed
skill's version identifier for searches. It forwards CLI output and exit codes,
including the CLI's temporary-file instructions for long retrieved guides.

If the package is not cached, run these commands from this project in a terminal
with registry network access:

```sh
npm install --prefix .tools/modern-web-guidance-download --cache .tools/npm-cache --no-audit --no-fund --ignore-scripts --save-exact modern-web-guidance@0.0.197
node scripts/modern-web-guidance.mjs setup --from .tools/modern-web-guidance-download/node_modules/modern-web-guidance
```

This installs only development tooling in ignored project storage. It does not
change global npm settings or add extension dependencies. Upgrades require an
explicit change to the launcher's version pin and a new setup; normal use stays
on 0.0.197. Do not use `npx --offline` with an empty `/tmp/npm-cache`: an offline
cache miss is not evidence that the package is unavailable elsewhere on the machine.

The launcher resolves its own project location. From another directory, invoke
it by absolute path, for example:

```sh
node /absolute/path/to/microburbs_facts/scripts/modern-web-guidance.mjs search "respect text scaling"
```

## Visible browser verification

Use a normal, visible Chrome window with the available browser-control tools.
Keep checks in a dedicated test window and preserve unrelated user tabs. Native
app controls can operate the toolbar and side panel when browser-tab controls
cannot reach them. Browser verification needs no package installation or local
browser download.

1. Open `chrome://extensions`, load this project as an unpacked extension if
   needed, or click **Reload** on its existing card. Confirm its name and icon,
   and inspect any extension errors and the service worker console.
2. Open the extension from Chrome's toolbar. Confirm the heading and all three
   buttons are visible. Tab through **Open options**, **Open side panel** and
   **Show page widget** in order; verify visible focus, Enter/Space activation,
   and Escape dismissal of the native popup.
3. Use **Open options** twice. Confirm the branded options page opens and the
   second action focuses the same tab rather than creating a duplicate.
4. Use **Open side panel**. Confirm the actual panel opens in the current window,
   displays its heading and icon, docks beside the page and resizes correctly.
5. Reload an ordinary HTTP or HTTPS test page and confirm no widget appears.
   Click **Show page widget** to display it, then repeat the command to confirm
   only one widget exists. Dismiss it with its close button and reopen it using
   **Show page widget**. Refresh the page or navigate to another page and confirm
   no widget appears until another click. Check mouse and keyboard dismissal,
   style isolation from the host page and absence from child frames and extension
   pages. Reload web pages that were open before installing/reloading the extension.
6. On a protected page such as `chrome://extensions`, use **Show page widget**.
   Confirm the popup displays an actionable error rather than claiming success.
7. Inspect the popup, options, side panel and widget at a narrow width and at
   200% zoom. Confirm text and controls wrap without horizontal clipping. Capture
   and review screenshots of the current UI, including error feedback.
8. Inspect the popup via its **Inspect** context-menu item and check the other
   extension pages' consoles for JavaScript, resource-loading or content security
   policy errors.

Opening extension documents in tabs helps inspect layout but does not verify
native toolbar opening/dismissal or side panel docking. Report exactly which
checks passed. If browser access or a native control is unavailable, identify the
blocker and leave those checklist items pending for a manual Chrome session.
Do not substitute mocked API tests or old screenshots for observed behavior.

### Welcome tab manual checks

In a separate Chrome profile, load the extension as unpacked to test a fresh
installation without disturbing your working installation:

1. Confirm exactly one active welcome tab opens with the icon and greeting.
2. Close the welcome tab, then reload the extension. Confirm no welcome tab opens.
3. Restart Chrome and confirm the extension does not create a new welcome tab.
4. On the welcome page, check a narrow window and 200% zoom for readable, wrapping
   text without horizontal clipping.

These browser checks await user feedback; automated tests below use mocked APIs.

## Local checks

Use Node.js 22.12+ and Python 3. Install dependencies with `npm ci`, then run:

```sh
npm run typecheck
npm run test:ui
npm run build
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p '*_test.py'
npm run test:package
```

The background tests use mocked Chrome APIs to check welcome-tab behavior, menu
creation on install/update, text/URL capture, worker restarts and failure handling.
Notepad tests cover persistence, concurrent saves, changes while deleting, stale
reads, literal text rendering, validation and focus after deletion.
Content-script tests use mocked Chrome APIs and
DOM elements to check click-only creation, duplicate prevention, dismissal and
stylesheet failure/retry behavior. The React UI tests use mocked Chrome APIs and a real DOM to check dispatch,
rendering, errors, retries and unmount cleanup. Package verification rebuilds the
ZIP and compares its runtime files with the source, ensuring development tooling
stays out. These automated checks complement visible browser checks; they do not
verify rendering, native toolbar behavior or side panel docking. The click-only
widget behavior awaits user feedback from the manual checklist above.

Selection-card tests cover mouse/keyboard selection, editable-field exclusions,
dismissal, viewport positioning, duplicate-save prevention, stale save/style
responses, retry and integration with the background save handler. The background
tests also verify selection-message sender validation and responses after persistence.
For manual checks, run `python3 -m http.server 8766 --bind 127.0.0.1` from this
repository and open `http://127.0.0.1:8766/tests/fixtures/selection-card.html` in
Chrome with the extension loaded. This development fixture is excluded from the ZIP.
It includes an example Sydney address for checking the native context-menu lookup.

Property tests use fake responses and dummy credentials, never a real API key.
They cover candidate filtering, unit-address encoding, partial failures, null/zero
handling, overlay containment, sender validation, request coalescing, throttling,
HTTP errors, `Retry-After`, timeout and stale replies. Python tests build temporary
copies with dummy configuration and verify permissions, source preservation and
package exclusions. `tests/fixtures/property-preview.html` is a labelled mock-data
preview of the lookup UI served by the same local development server.
Context-menu tests also cover removal of URL saving, lookup delivery to the clicked
tab, native-menu selection snapshots, stale requests and legacy URL-note display/deletion.

## Publication status

This is an installable extension shell, not a feature-complete product. Its current
functionality may be rejected under Chrome Web Store's minimum functionality requirements.
Add useful functionality before seeking public approval. Nothing has been submitted
or published. See `docs/store/listing.md` for accurate draft copy and preparation steps.

## Expanded property card verification

On 2026-11-07, the rebuilt unpacked extension was reloaded in native Chrome.
Selecting **26 Tudor Street, Surry Hills**, choosing the Sydney match and opening
all five new sections loaded live market, planning, school, amenity and transport
data. Amenity totals and returned-list lengths differed in the live response and
were displayed separately. At 200% page zoom, market and transport results
wrapped within the card and scrolled internally while the full selected address
remained visible. Browser zoom was restored, and no notes were added or deleted.

The separate mock preview verified keyboard expansion and native browser Find:
searching for text in a previously loaded, collapsed planning section reopened
it and synchronized the trigger state. Automated tests cover lazy loading,
reopening without refetching, additional rows, missing and zero values,
independent market retries, rate-limit timing, stale replies and validated
worker routes. Package checks validate local assets and development-file
exclusions. Full screen-reader testing and a complete console/CSP inspection
remain manual checks.

## Shadcn makeover verification

On 2026-11-06, the installed unpacked extension was reloaded and checked in
native Chrome. The 360px toolbar popup displayed its shadcn controls and the
existing saved note. Options opened from the popup, and the side panel opened
and docked with the shared branded guide. The welcome page and dismissible
page widget were visually reviewed.

On the selection fixture at 200% page zoom, selecting **26 Tudor Street,
Surry Hills** showed both actions beside the selection. Tab produced a visible
focus outline. Live lookup returned address choices; selecting the Sydney match
loaded facts, valuation and overlays. Expanded results moved below the address,
kept the complete selected address visible, and scrolled internally with Page
Down. Escape dismissed the card. Browser zoom was restored using Chrome's Reset
control. No notes were added or deleted during these checks.

The separate mock-data preview verified unit-address choices, zero parking and
missing values. Automated React tests cover save/delete errors, concurrent
changes, draft preservation, storage failures, partial API failures, retry timing,
stale replies and root cleanup. Controller tests cover selection recovery and
fallback positioning; package checks validate bundled resources and exclusions.
Full screen-reader testing, a complete console/CSP inspection, and a Chrome
restart remain manual checks. Historical checks below predate this makeover.

## Visible browser checks performed

On 2026-11-06, side placement was checked in visible Chrome on the selection-card
fixture. At 100% zoom, both the compact card and live results appeared to the
right of a two-line address without covering either line. At 200% zoom, the
bottom-edge address first showed the compact card on its left; expanding lookup
results used the space below and scrolled enough to expose the full address
above the card. Native context-menu lookup used the same below-address placement.
User scrolling dismissed the card, and the test page's zoom was restored to 100%.

On 2026-11-06, the rebuilt extension's native context menu was checked in visible
Chrome on the local selection-card fixture. Right-clicking the selected
**26 Tudor Street, Surry Hills** address showed **Save selected text to notes**
and **Look up property** in the extension submenu, with no URL-saving action.
Choosing **Look up property** opened address choices in the card; choosing the
Sydney match loaded live facts, valuation and risks without a second lookup click.

On 2026-11-06, selection-card recovery was checked in visible Chrome. A card
opened on the local fixture; after reloading the extension while that page stayed
open, selecting text removed the stale card and recorded the actionable webpage
reload diagnostic. Refreshing the fixture restored both actions. A fresh tab at
the originally reported Microburbs developer billing page also showed **Save to
notes** and **Look up property** when its Billing heading was selected. No API
requests or note writes were needed for these recovery checks. Simulated lookup,
popover and stylesheet failures are covered by automated regression tests.

On 2026-11-06, the real extension's lookup action was checked without a key and
displayed `.env.local` setup guidance. The separate labelled mock-data preview
verified address choices, selected unit-address display, facts including zero
parking, valuation formatting, overlay labels, neighbourhood context and internal
card scrolling. These previews do not verify live API availability or real
address matching.

On 2026-11-06, authenticated requests to the configured production API returned
HTTP 200 for `/v1/me`, address search for **26 Tudor Street, Surry Hills**, and
that property's facts, valuation and risks. The existing generated build had no
key and targeted a different API host; rebuild from `.env.local`, reload the
extension from `dist/unpacked/`, and refresh existing webpages to apply the
current configuration. These HTTP checks verify API access separately from
browser rendering.

The subsequent visible Chrome check confirmed the installed extension was
loading the repository root and therefore the empty source configuration.
The root installation was disabled, preserving its notes, and the rebuilt
`dist/unpacked/` installation was loaded. On a local address-only verification
page, selecting **26 Tudor Street, Surry Hills**, clicking **Look up property**,
and choosing the matching address loaded live property facts, valuation and
risks. **Save to notes** then displayed **Note saved.** The new installation has
separate note storage from the disabled root installation.

On 2026-11-06, the selection card was checked in visible Chrome on the local
verification page. Selecting text showed the card, clicking Save preserved the
selection and showed success, and the note appeared in the native toolbar popup.
Textarea and editable-content selections showed no card. Tab focused Save with a
visible focus ring; Enter saved the note. Escape and scrolling dismissed the card,
and a selection at the bottom of the viewport placed it above the text.
Only the notes created during these checks were deleted; existing notes were kept.
The fallback without native popovers, asynchronous failure/retry and stale-response
handling are covered by automated tests rather than these visible checks.

The popup sizing fix was subsequently checked on 2026-11-06 in visible Chrome.
A definite 320px root width replaces the viewport-dependent sizing that collapsed
the native popup into a narrow column. The actual toolbar popup now shows the
heading, all three buttons, keyboard focus outlines and wrapped error feedback
within its bounds; Escape dismissal and options/side panel opening were checked.

The notepad was also checked on 2026-11-06 in the native toolbar popup in visible
Chrome: multiline and Unicode text, literal HTML-like text, long-URL wrapping,
list scrolling, reopening saved notes, persistence through extension reload,
keyboard deletion and editor focus after deleting the final note, and selected-text
and page-URL context-menu capture passed. Options and side-panel opening and widget
success feedback also passed. All notes created for these checks were removed.
A full Chrome restart remains a manual check.
The popup document and its error message also fit when opened in a tab at 200%
zoom. Chrome kept the native toolbar popup at its own default scale during that
tab zoom check, so this is not evidence of a native popup rendered at 200%.
Screenshots were captured and reviewed through the native browser controls,
zoom was restored to 100%, and the dedicated test window was closed. All five
handler tests and ZIP verification passed after the HTML/CSS changes.

On 2026-11-06, checks in a dedicated normal Chrome window verified extension
reload, native toolbar popup opening, button tab order, Enter activation and
Escape dismissal, options-tab opening/reuse, actual side panel opening/docking,
protected-page feedback, and widget dismissal/restoration without duplicates.
Side panel and widget screenshots were reviewed. All five mocked popup handler
tests and runtime ZIP verification passed; the 17 extension runtime files were
unchanged by the tooling cleanup.

Browser-tab access was unavailable, so checks used native Chrome controls. Native
resize actions did not visibly change the panel width, leaving resizing pending.
Further UI checks stopped when focus returned to the user's working window.
Complete the checklist above in a dedicated test window for panel resizing,
narrow-width/200% zoom layout and focus-ring appearance, full console inspection,
widget keyboard dismissal, style isolation and child-frame exclusion. These
checks have not been verified in this session.

## Previous manual verification

Verified in desktop Chrome 156: unpacked installation, toolbar popup rendering,
Escape dismissal, a clean popup-page console, and readable content at 200% page
zoom. The heading's text contrast is 11.24:1. All four PNG dimensions and manifest
references were checked, and the ZIP's runtime files match the source.

`docs/store/popup-screenshot.png` is a 1280 × 800 capture of the installed extension's
popup document opened directly in a tab at 100% zoom and device pixel ratio 1.
It predates the launcher buttons and needs replacing before submission.
It contains no browser chrome or account details.

References: [Manifest format](https://developer.chrome.com/docs/extensions/reference/manifest),
[content security policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy),
[store image requirements](https://developer.chrome.com/docs/webstore/images),
[minimum functionality](https://developer.chrome.com/docs/webstore/program-policies/minimum-functionality).
