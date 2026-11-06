# Chrome Web Store listing draft

## Name

Microburbs Facts

## Short description

Look up selected property addresses, keep local notes and open Microburbs Facts tools.

## Detailed description

Click the Microburbs Facts toolbar icon to write, view and delete local notes in
a scrollable list. Right-click selected text to save it as a note or choose
**Look up property** for a selected address. Selecting regular page text also shows a compact
**Save to notes** card next to the selection. Click Save to capture it, or dismiss
the card with Escape. The card supports keyboard access and excludes editable
fields and embedded frames. Notes stay in this browser profile; they are not
synced or sent to a server, and uninstalling the extension removes them.
The popup also includes buttons to open the options page and side panel,
or show the dismissible page widget on the active web page.
Select one address and choose **Look up property** in the card or right-click
menu to match it with the configured
Microburbs Hackathon API. Choose among address candidates and view property facts,
automated valuation and property overlays/nearby features in the expanded card.
API coverage is limited to the City of Sydney LGA and requires a team key in the
local build configuration. Lookup does not automatically save a note.
Matching options and side panel pages display the same branding. The widget
appears on ordinary HTTP and HTTPS pages only when you click **Show page widget**
in the popup. After closing it, refreshing the page or navigating to another page,
click the button again to show it.

Notes work offline. Property address searches require a network connection and
the configured Microburbs API key. This version
requests the sidePanel, storage and contextMenus API permissions and site access
to inject its widget and selection card on HTTP and HTTPS pages. Note contents are stored locally
only after a user chooses to save them.

## Single purpose

Capture selected text as local notes and look up Australian property information for selected addresses within the API's coverage.

## Privacy disclosures for this version

- User-entered notes and explicitly saved selected text are stored locally in the Chrome profile. Previously saved URL notes are retained. Saved notes are not transmitted, sold or synced.
- No browsing history is read. The content script reads the current selection temporarily to show its card. Selected text is saved locally only when the user clicks the card's Save button or the selected-text context-menu action.
- Choosing **Look up property** in the card or context menu transmits the selected address, then the chosen GNAF identifier, to the configured Microburbs API using the team key. Results are displayed temporarily; this extension does not persist them as notes automatically.
- No analytics, remote code, cookies or external services are included.
- The sidePanel, storage and contextMenus API permissions and HTTP/HTTPS site access through content script match patterns are requested.
- The generated build requests host access and connection permission only for the configured API HTTPS origin. Its worker-only generated configuration contains the inspectable team key; this local team package must not be publicly distributed with a private key.

Reassess these declarations if functionality changes. Complete any required
publisher declarations truthfully in the Developer Dashboard at submission time.

## Submission preparation

1. Add useful functionality before seeking public approval: this extension shell
   may fail the store's minimum functionality requirements.
2. Recheck the listing and privacy disclosures against that final version.
3. Run `python3 scripts/package.py` and upload the resulting ZIP when ready.
4. Use `icons/icon-128.png` as the store icon. Replace `store/popup-screenshot.png`
   before submission: it predates the launcher buttons and notepad. Capture the updated popup
   document from the installed extension in a tab at 1280 × 800, 100% zoom and
   device pixel ratio 1.
5. Complete publisher account setup, category, contact and any required privacy
   policy fields in the Dashboard. These are account-specific and are not
   fabricated in this project.
6. Preview the listing and submit for review only when ready to publish.

No account setup, upload or publication has been performed.
