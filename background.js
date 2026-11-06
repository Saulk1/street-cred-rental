// Background service worker for the Microburbs Facts extension.
importScripts("consts.js");

async function saveNote(text, type) {
  const id = crypto.randomUUID();
  await chrome.storage.local.set({
    [NOTEPAD.KEY_PREFIX + id]: { id, text, createdAt: Date.now(), type },
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== NOTEPAD.MESSAGES.SAVE_SELECTION_NOTE) return;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0
    || !Number.isInteger(sender.tab?.id) || !/^https?:\/\//.test(sender.url ?? "")
    || typeof message.text !== "string" || !message.text.trim()) {
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
      { id: NOTEPAD.MENUS.URL, title: "Save page URL to notes", contexts: ["page"] },
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
chrome.contextMenus.onClicked.addListener(async info => {
  let text;
  let type;
  if (info.menuItemId === NOTEPAD.MENUS.SELECTION) {
    text = info.selectionText;
    type = NOTEPAD.TYPES.SELECTION;
  } else if (info.menuItemId === NOTEPAD.MENUS.URL) {
    text = info.pageUrl;
    type = NOTEPAD.TYPES.URL;
  } else {
    return;
  }
  if (typeof text !== "string" || !text.trim()) return;

  try {
    await saveNote(text, type);
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
