// Background service worker for the Microburbs Facts extension.
importScripts("consts.js");
// The source placeholder is replaced with generated config in dist/unpacked.
try { importScripts("runtime-config.js"); } catch { /* API reports a configuration error on lookup. */ }
importScripts("property-api.js");

async function saveNote(text, type) {
  const id = crypto.randomUUID();
  await chrome.storage.local.set({
    [NOTEPAD.KEY_PREFIX + id]: { id, text, createdAt: Date.now(), type },
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (![NOTEPAD.MESSAGES.SAVE_SELECTION_NOTE, NOTEPAD.MESSAGES.SEARCH_ADDRESS,
    NOTEPAD.MESSAGES.PROPERTY_DETAILS].includes(message?.type)) return;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0
    || !Number.isInteger(sender.tab?.id) || !/^https?:\/\//.test(sender.url ?? "")) {
    sendResponse({ ok: false });
    return;
  }
  if (message.type === NOTEPAD.MESSAGES.SEARCH_ADDRESS || message.type === NOTEPAD.MESSAGES.PROPERTY_DETAILS) {
    const search = message.type === NOTEPAD.MESSAGES.SEARCH_ADDRESS;
    const value = search ? message.address : message.id;
    if (typeof value !== "string" || (search ? value.trim().length < 2 || value.length > 1000 : !/^[A-Za-z0-9_-]{1,80}$/.test(value))) {
      sendResponse({ ok: false, error: { code: "validation", message: "Select one address with at least two characters (maximum 1000)." } });
      return;
    }
    const operation = search ? PROPERTY_API.search(value.trim().replace(/\s+/g, " ")) : PROPERTY_API.details(value);
    operation.then(sendResponse, () => sendResponse({ ok: false, error: { code: "server", message: "Could not look up this property. Please retry." } }));
    return true;
  }
  if (typeof message.text !== "string" || !message.text.trim()) {
    sendResponse({ ok: false });
    return;
  }
  saveNote(message.text, NOTEPAD.TYPES.SELECTION).then(
    () => sendResponse({ ok: true }),
    () => {
      console.error("Could not save the selection-card note. Please try again.");
      sendResponse({ ok: false });
    },
  );
  // Chrome 116 needs a literal true to keep asynchronous responses alive.
  return true;
});

// Keep this separate from welcome-tab handling so either task can fail independently.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install" && reason !== "update") return;

  try {
    // Use callbacks for contextMenus APIs to retain Chrome 116 compatibility.
    await new Promise((resolve, reject) => {
      chrome.contextMenus.removeAll(() => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
    for (const properties of [
      { id: NOTEPAD.MENUS.SELECTION, title: "Save selected text to notes", contexts: ["selection"] },
      { id: NOTEPAD.MENUS.LOOKUP, title: "Look up property", contexts: ["selection"],
        documentUrlPatterns: ["http://*/*", "https://*/*"] },
    ]) {
      await new Promise((resolve, reject) => {
        chrome.contextMenus.create(properties, () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        });
      });
    }
  } catch {
    console.error("Could not set up the notepad context menus. Reload the extension to try again.");
  }
});

// Register at startup, rather than inside onInstalled, to handle worker restarts.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const text = info.selectionText;
  if (info.menuItemId === NOTEPAD.MENUS.LOOKUP) {
    if (!Number.isInteger(tab?.id) || tab.id < 0 || info.editable
      || (info.frameId !== undefined && info.frameId !== 0)
      || !/^https?:\/\//.test(info.pageUrl ?? "")
      || typeof text !== "string" || text.trim().length < 2 || text.length > 1000) return;
    try {
      const response = await chrome.tabs.sendMessage(tab.id,
        { type: NOTEPAD.MESSAGES.LOOK_UP_SELECTION, text }, { frameId: 0 });
      if (!response?.ok) throw new Error("Lookup unavailable");
    } catch {
      console.error("Could not open property lookup. Reload this webpage, select an address and try again.");
    }
    return;
  }
  if (info.menuItemId !== NOTEPAD.MENUS.SELECTION || typeof text !== "string" || !text.trim()) return;

  try {
    await saveNote(text, NOTEPAD.TYPES.SELECTION);
  } catch {
    // Do not include selected text or URLs in diagnostic output.
    console.error("Could not save the context-menu note. Please try again.");
  }
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;

  try {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("welcome/welcome.html"),
      active: true,
    });
  } catch (error) {
    console.error("Could not open the Microburbs Facts welcome page.", error);
  }
});
