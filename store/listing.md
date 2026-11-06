# Chrome Web Store listing draft

## Name

Microburbs Facts

## Short description

Open Microburbs Facts options, side panel and page widget from the toolbar popup.

## Detailed description

Microburbs Facts version 0.1.0 is a minimal extension shell. Click its toolbar icon
to open a compact popup with buttons to open the options page and side panel,
or show the dismissible page widget on the active web page.
Matching options and side panel pages display the same branding. The widget
appears on ordinary HTTP and HTTPS pages only when you click **Show page widget**
in the popup. After closing it, refreshing the page or navigating to another page,
click the button again to show it.

This version does not display suburb facts or perform searches. It works offline,
requests the sidePanel API permission and site access to inject its widget on HTTP
and HTTPS pages, and collects no user data.

## Single purpose

Display the Microburbs Facts name in a toolbar popup, options page, side panel and page widget.

## Privacy disclosures for this version

- No user data is collected, stored, used, sold or transferred.
- No browsing history or existing page text is read; the content script inserts its own widget DOM.
- No analytics, remote code, cookies or external services are included.
- The sidePanel API permission and HTTP/HTTPS site access through content script match patterns are requested.

Reassess these declarations if functionality changes. Complete any required
publisher declarations truthfully in the Developer Dashboard at submission time.

## Submission preparation

1. Add useful functionality before seeking public approval: this extension shell
   may fail the store's minimum functionality requirements.
2. Recheck the listing and privacy disclosures against that final version.
3. Run `python3 scripts/package.py` and upload the resulting ZIP when ready.
4. Use `icons/icon-128.png` as the store icon. Replace `store/popup-screenshot.png`
   before submission: it predates the launcher buttons. Capture the updated popup
   document from the installed extension in a tab at 1280 × 800, 100% zoom and
   device pixel ratio 1.
5. Complete publisher account setup, category, contact and any required privacy
   policy fields in the Dashboard. These are account-specific and are not
   fabricated in this project.
6. Preview the listing and submit for review only when ready to publish.

No account setup, upload or publication has been performed.
