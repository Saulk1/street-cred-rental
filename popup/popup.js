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

const noteForm = document.getElementById("note-form");
const noteText = document.getElementById("note-text");
const saveNoteButton = document.getElementById("save-note");
const notesList = document.getElementById("notes-list");
const notesEmpty = document.getElementById("notes-empty");
const pendingDeletes = new Set();
let loadVersion = 0;
let hasLoadedNotes = false;

function renderNotes(notes) {
  const oldButtons = [...notesList.querySelectorAll("button")];
  const focusedIndex = oldButtons.indexOf(document.activeElement);
  const focusedId = document.activeElement?.dataset.noteId;
  const scrollTop = notesList.scrollTop;
  const items = notes.map(note => {
    const item = document.createElement("li");
    const content = document.createElement("p");
    content.className = "note-content";
    content.textContent = note.text;
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "Delete";
    removeButton.dataset.noteId = note.id;
    removeButton.setAttribute("aria-label", `Delete note: ${note.text.replace(/\s+/g, " ").slice(0, 60)}`);
    removeButton.setAttribute("aria-disabled", String(pendingDeletes.has(note.id)));
    removeButton.addEventListener("click", () => deleteNote(note.id));
    item.append(content, removeButton);
    return item;
  });
  notesList.replaceChildren(...items);
  notesList.hidden = notes.length === 0;
  notesEmpty.hidden = notes.length > 0;
  notesEmpty.textContent = "No saved notes yet.";
  notesList.scrollTop = scrollTop;
  if (focusedIndex !== -1) {
    const buttons = [...notesList.querySelectorAll("button")];
    const target = buttons.find(button => button.dataset.noteId === focusedId)
      ?? buttons[Math.min(focusedIndex, buttons.length - 1)] ?? noteText;
    target.focus();
  }
}

async function loadNotes() {
  const version = ++loadVersion;
  try {
    const stored = await chrome.storage.local.get(null);
    if (version !== loadVersion) return;
    const notes = Object.entries(stored)
      .filter(([key, note]) => key.startsWith(NOTEPAD.KEY_PREFIX)
        && note && typeof note.id === "string" && key === NOTEPAD.KEY_PREFIX + note.id
        && typeof note.text === "string" && Number.isFinite(note.createdAt)
        && Object.values(NOTEPAD.TYPES).includes(note.type))
      .map(([, note]) => note)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    renderNotes(notes);
    hasLoadedNotes = true;
  } catch {
    if (version !== loadVersion) return;
    if (!hasLoadedNotes) notesEmpty.textContent = "Saved notes could not be loaded.";
    status.textContent = "Could not load notes. Reopen the popup to try again.";
  }
}

noteText.addEventListener("input", () => noteText.setCustomValidity(""));
noteForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (saveNoteButton.disabled) return;
  const text = noteText.value;
  if (!text.trim()) {
    noteText.setCustomValidity("Enter a note before saving.");
    noteText.reportValidity();
    return;
  }
  saveNoteButton.disabled = true;
  status.textContent = "";
  try {
    const id = crypto.randomUUID();
    await chrome.storage.local.set({
      [NOTEPAD.KEY_PREFIX + id]: { id, text, createdAt: Date.now(), type: NOTEPAD.TYPES.MANUAL },
    });
    // Preserve any new text entered while the save was pending.
    if (noteText.value === text) noteText.value = "";
    status.textContent = "Note saved.";
    await loadNotes();
  } catch {
    status.textContent = "Could not save the note. Your text is still here; please try again.";
  } finally {
    saveNoteButton.disabled = false;
  }
});

async function deleteNote(id) {
  if (pendingDeletes.has(id)) return;
  pendingDeletes.add(id);
  const button = [...notesList.querySelectorAll("button")].find(item => item.dataset.noteId === id);
  button?.setAttribute("aria-disabled", "true");
  status.textContent = "";
  try {
    await chrome.storage.local.remove(NOTEPAD.KEY_PREFIX + id);
    status.textContent = "Note deleted.";
    await loadNotes();
  } catch {
    status.textContent = "Could not delete the note. Please try again.";
  } finally {
    pendingDeletes.delete(id);
    // A storage update may have replaced this row while the removal was pending.
    const currentButton = [...notesList.querySelectorAll("button")].find(item => item.dataset.noteId === id);
    currentButton?.setAttribute("aria-disabled", "false");
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some(key => key.startsWith(NOTEPAD.KEY_PREFIX))) {
    void loadNotes();
  }
});
void loadNotes();
