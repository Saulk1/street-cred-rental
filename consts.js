"use strict";

// Loaded by the popup, content scripts and classic background service worker.
const NOTEPAD = Object.freeze({
  KEY_PREFIX: "microburbs.note.",
  // Retain URL as a legacy stored type so older notes stay readable/deletable.
  TYPES: Object.freeze({ MANUAL: "manual", SELECTION: "selection", URL: "url" }),
  MENUS: Object.freeze({ SELECTION: "save-selection-note", LOOKUP: "look-up-property" }),
  MESSAGES: Object.freeze({
    SAVE_SELECTION_NOTE: "SAVE_SELECTION_NOTE",
    LOOK_UP_SELECTION: "LOOK_UP_SELECTION",
    SEARCH_ADDRESS: "SEARCH_ADDRESS",
    PROPERTY_DETAILS: "PROPERTY_DETAILS",
  }),
});
