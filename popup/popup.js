"use strict";

const status = document.getElementById("status");
const sidePanelButton = document.getElementById("open-side-panel");
let currentWindowId;

// Resolve the window before a click so sidePanel.open runs in the user gesture.
chrome.windows.getCurrent().then(currentWindow => {
  if (!Number.isInteger(currentWindow.id)) throw new Error("No current window.");
  currentWindowId = currentWindow.id;
  sidePanelButton.disabled = false;
}).catch(() => {
  status.textContent = "Could not find this browser window. Reopen the popup to try again.";
});

function onAction(id, action, successMessage, errorMessage) {
  document.getElementById(id).addEventListener("click", async () => {
    status.textContent = "";
    try {
      // Invoke immediately: awaiting another API here can lose the user gesture.
      await action();
      status.textContent = successMessage;
    } catch {
      status.textContent = errorMessage;
    }
  });
}

onAction("open-options", () => chrome.runtime.openOptionsPage(),
  "Options opened.", "Could not open options. Please try again.");

onAction("open-side-panel", () => chrome.sidePanel.open({ windowId: currentWindowId }),
  "Side panel opened.", "Could not open the side panel. Try again in Chrome 116 or newer.");

onAction("show-widget", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id)) throw new Error("No active tab.");
  const response = await chrome.tabs.sendMessage(tab.id, { type: "SHOW_WIDGET" }, { frameId: 0 });
  if (!response?.ok) throw new Error("Widget could not open.");
}, "Page widget shown.", "Could not show the widget. Open a regular web page and reload it, then try again.");
