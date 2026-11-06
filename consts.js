"use strict";

// Loaded by the popup, content scripts and classic background service worker.
const NOTEPAD = Object.freeze({
  KEY_PREFIX: "microburbs.note.",
  TYPES: Object.freeze({ MANUAL: "manual", SELECTION: "selection", URL: "url" }),
  MENUS: Object.freeze({ SELECTION: "save-selection-note", URL: "save-page-url-note" }),
  MESSAGES: Object.freeze({ SAVE_SELECTION_NOTE: "SAVE_SELECTION_NOTE" }),
});
