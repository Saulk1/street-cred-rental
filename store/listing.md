# Chrome Web Store listing draft

## Name

Microburbs Facts

## Short description

Keep local notes, save selected text and page URLs, and open Microburbs Facts tools.

## Detailed description

Click the Microburbs Facts toolbar icon to write, view and delete local notes in
a scrollable list. Right-click selected text or a page background to save text or
the current page URL as a note. Selecting regular page text also shows a compact
**Save to notes** card next to the selection. Click Save to capture it, or dismiss
the card with Escape. The card supports keyboard access and excludes editable
fields and embedded frames. Notes stay in this browser profile; they are not
synced or sent to a server, and uninstalling the extension removes them.
The popup also includes buttons to open the options page and side panel,
or show the dismissible page widget on the active web page.
Matching options and side panel pages display the same branding. The widget
appears on ordinary HTTP and HTTPS pages only when you click **Show page widget**
in the popup. After closing it, refreshing the page or navigating to another page,
click the button again to show it.

This version does not display suburb facts or perform searches. It works offline,
requests the sidePanel, storage and contextMenus API permissions and site access
to inject its widget and selection card on HTTP and HTTPS pages. Note contents are stored locally
only after a user chooses to save them.

## Single purpose

Keep a local notepad of user-entered notes, selected text and page URLs alongside Microburbs Facts tools.

## Privacy disclosures for this version

- User-entered notes, explicitly selected text and page URLs are stored locally in the Chrome profile. They are not transmitted, sold or synced.
- No browsing history is read. The content script reads the current selection temporarily to show its card. Selected text is saved locally only when the user clicks the card's Save button or the selected-text context-menu action.
- No analytics, remote code, cookies or external services are included.
- The sidePanel, storage and contextMenus API permissions and HTTP/HTTPS site access through content script match patterns are requested.

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
