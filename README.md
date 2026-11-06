# Microburbs Facts

**Beta extension for the Microburbs Hackathon 2026, built by team Street Cred.**

A minimal Manifest V3 Chrome extension made with plain HTML, CSS and JavaScript.
Version 0.1.0 opens a toolbar popup with buttons for the options page, side panel
and page widget. It includes matching options and side panel pages, and requests only the
`sidePanel` API permission. A content script waits for **Show page widget** before
adding a dismissible widget to an ordinary HTTP or HTTPS page; its manifest match
patterns request access to those sites.

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

1. Open `chrome://extensions` in desktop Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this project folder (the folder containing `manifest.json`).
4. Pin **Microburbs Facts** from Chrome's Extensions menu and click its icon.

Keep Developer mode on while using the unpacked extension; current Chrome disables
unpacked extensions when it is turned off.

On a fresh installation, a new active tab displays the extension icon and
**Welcome to Microburbs Facts!** Close the tab normally when finished. The greeting
does not reopen on extension reloads, updates, browser updates or browser restarts.
Uninstalling and reinstalling counts as a fresh installation and shows it again.
Existing users receiving an update do not see the welcome tab.

After editing the source, click **Reload** on its card in `chrome://extensions`,
then reopen the popup. No install command, build step or development server is needed.

Use **Open options** in the popup to open or focus the options tab. You can also
right-click the extension's toolbar icon and choose **Options**. The page currently
displays a heading and icon. Use **Open side panel** to open the matching panel in
the current browser window (Chrome 116 or newer).

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

## Files

- `manifest.json`: extension metadata, toolbar action, icons and content security policy.
- `popup/`: contains `popup.html`, `popup.css` and `popup.js` for the launcher buttons, Chrome API handlers and accessible status feedback.
- `options/`: contains `options.html`, `options.css` and `options.js` for the matching options page.
- `sidepanel/`: contains `sidepanel.html`, `sidepanel.css` and `sidepanel.js` for the matching side panel page.
- `welcome/`: contains the static greeting page and stylesheet opened on a fresh installation.
- `content-script/`: contains `content-script.js` and `content-script.css` for the widget and its show-message handler, matching the popup and options colours and typography. CSS is registered in the manifest and loaded into the widget's Shadow DOM; only the CSS file is web accessible.
- `background.js`: the extension service worker, which opens the welcome tab only for a fresh installation and logs tab-creation failures without retrying.
- `icons/`: original PNG artwork in Chrome's required sizes; editable source in `assets/icon.svg`.
- `store/`: listing draft and screenshot for submission preparation; not extension runtime files.

The extension makes no external network requests, reads no page text or browsing history,
stores no data and includes no telemetry. Its content script adds and removes its
own widget DOM without changing the page's existing content. Extension pages'
content security policy permits only bundled scripts, styles and images.

## Package

Run with Python 3 (standard library only):

```sh
python3 scripts/package.py
```

The archive is `dist/microburbs-facts-0.1.0.zip`. Its manifest is at the ZIP root;
only runtime files and the MIT license are included. Documentation, skills,
source artwork, screenshots and the packaging script stay out of the upload.

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

Use Node.js 22+ and Python 3; no npm dependencies are required:

```sh
node --test tests/background.test.mjs
node --test tests/content-script.test.mjs
node --test tests/popup.test.mjs
npm run test:package
```

The background tests use mocked Chrome APIs to check install-only welcome-tab
creation and failure handling. Content-script tests use mocked Chrome APIs and
DOM elements to check click-only creation, duplicate prevention, dismissal and
stylesheet failure/retry behavior. The popup tests use mocked Chrome APIs and DOM
controls to check dispatch and error handling. Package verification rebuilds the
ZIP and compares its runtime files with the source, ensuring development tooling
stays out. These automated checks complement visible browser checks; they do not
verify rendering, native toolbar behavior or side panel docking. The click-only
widget behavior awaits user feedback from the manual checklist above.

## Publication status

This is an installable extension shell, not a feature-complete product. Its current
functionality may be rejected under Chrome Web Store's minimum functionality requirements.
Add useful functionality before seeking public approval. Nothing has been submitted
or published. See `store/listing.md` for accurate draft copy and preparation steps.

## Visible browser checks performed

The popup sizing fix was subsequently checked on 2026-11-06 in visible Chrome.
A definite 320px root width replaces the viewport-dependent sizing that collapsed
the native popup into a narrow column. The actual toolbar popup now shows the
heading, all three buttons, keyboard focus outlines and wrapped error feedback
within its bounds; Escape dismissal and options/side panel opening were checked.
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

`store/popup-screenshot.png` is a 1280 × 800 capture of the installed extension's
popup document opened directly in a tab at 100% zoom and device pixel ratio 1.
It predates the launcher buttons and needs replacing before submission.
It contains no browser chrome or account details.

References: [Manifest format](https://developer.chrome.com/docs/extensions/reference/manifest),
[content security policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy),
[store image requirements](https://developer.chrome.com/docs/webstore/images),
[minimum functionality](https://developer.chrome.com/docs/webstore/program-policies/minimum-functionality).
