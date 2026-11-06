"use strict";

(() => {
  const controllerKey = "__microburbsFactsSelectionController";
  const cardId = "microburbs-facts-selection-card";
  if (window.top !== window || globalThis[controllerKey]) return;
  globalThis[controllerKey] = true;

  let card;
  let currentSelection;
  let dismissedSelection;
  let selecting = false;
  let frame;
  let version = 0;
  let stylesheet;

  function sameSelection(a, b) {
    return a && b && a.text === b.text && a.anchorNode === b.anchorNode
      && a.anchorOffset === b.anchorOffset && a.focusNode === b.focusNode && a.focusOffset === b.focusOffset;
  }

  function excluded(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return !element || element.isContentEditable
      || element.closest(`input, textarea, #${cardId}, #microburbs-facts-widget`);
  }

  function readSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1
      || excluded(selection.anchorNode) || excluded(selection.focusNode)
      || document.activeElement?.matches("input, textarea, [contenteditable]:not([contenteditable='false'])")) return;
    const text = selection.toString();
    if (!text.trim()) return;
    const range = selection.getRangeAt(0);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    const backwards = selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset;
    const rect = backwards ? rects[0] : rects.at(-1);
    if (!rect || rect.bottom <= 0 || rect.top >= window.innerHeight) return;
    return { text, rect, anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset,
      focusNode: selection.focusNode, focusOffset: selection.focusOffset };
  }

  function dismiss(remember = true) {
    if (remember && currentSelection) dismissedSelection = currentSelection;
    version++;
    if (card) {
      const { host, previousFocus } = card;
      card = undefined;
      if (document.activeElement === host) previousFocus?.focus({ preventScroll: true });
      host.remove();
    }
    currentSelection = undefined;
  }

  function loadStyles() {
    if (!stylesheet) {
      stylesheet = (async () => {
        const response = await fetch(chrome.runtime.getURL("content-script/selection-card.css"));
        if (!response.ok) throw new Error("Selection-card stylesheet unavailable.");
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(await response.text());
        return sheet;
      })().catch(error => { stylesheet = undefined; throw error; });
    }
    return stylesheet;
  }

  function position(host, rect) {
    const gap = 8;
    const bounds = host.getBoundingClientRect();
    const maxLeft = Math.max(gap, window.innerWidth - bounds.width - gap);
    const below = rect.bottom + gap;
    const top = below + bounds.height <= window.innerHeight - gap ? below : rect.top - bounds.height - gap;
    host.style.left = `${Math.max(gap, Math.min(rect.left, maxLeft))}px`;
    host.style.top = `${Math.max(gap, Math.min(top, window.innerHeight - bounds.height - gap))}px`;
  }

  async function show(selection) {
    dismiss(false);
    currentSelection = selection;
    const requestedVersion = version;
    try {
      const sheet = await loadStyles();
      if (requestedVersion !== version) return;
      const host = document.createElement("div");
      host.id = cardId;
      host.lang = "en";
      host.dir = "ltr";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.adoptedStyleSheets = [sheet];
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Save to notes";
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      status.setAttribute("aria-atomic", "true");
      shadow.append(button, status);
      // A mouse click should not collapse the selection or move page focus.
      button.addEventListener("pointerdown", event => {
        if (event.button === 0) event.preventDefault();
      });
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        status.textContent = "";
        try {
          const response = await chrome.runtime.sendMessage({
            type: NOTEPAD.MESSAGES.SAVE_SELECTION_NOTE, text: selection.text,
          });
          if (!response?.ok) throw new Error("Save unavailable.");
          if (card?.host !== host) return;
          button.textContent = "Saved to notes";
          status.textContent = "Note saved.";
        } catch {
          if (card?.host !== host) return;
          button.disabled = false;
          status.textContent = "Could not save. Try again.";
        }
        if (card?.host === host) position(host, selection.rect);
      });
      card = { host, button, previousFocus: document.activeElement };
      const usePopover = "popover" in HTMLElement.prototype;
      if (usePopover) {
        host.popover = "auto";
        host.addEventListener("toggle", event => {
          if (event.newState === "closed" && card?.host === host) dismiss();
        });
      }
      document.documentElement.append(host);
      if (usePopover) host.showPopover();
      position(host, selection.rect);
    } catch {
      if (requestedVersion === version) {
        dismiss(false);
        console.error("Could not show the selection card. Select text again to retry.");
      }
    }
  }

  function update() {
    frame = undefined;
    if (selecting || (card && document.activeElement === card.host)) return;
    const selection = readSelection();
    if (!selection) {
      dismissedSelection = undefined;
      dismiss(false);
      return;
    }
    if (sameSelection(selection, dismissedSelection)) return;
    dismissedSelection = undefined;
    if (!sameSelection(selection, currentSelection)) void show(selection);
  }

  function scheduleUpdate() {
    if (frame === undefined) frame = requestAnimationFrame(update);
  }

  document.addEventListener("selectionchange", scheduleUpdate);
  document.addEventListener("pointerdown", event => {
    if (card && event.composedPath().includes(card.host)) return;
    selecting = event.button === 0;
    dismiss();
  }, true);
  document.addEventListener("pointerup", () => { selecting = false; scheduleUpdate(); });
  document.addEventListener("pointercancel", () => { selecting = false; dismiss(); });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") dismiss();
    // Offer the contextual action on the next Tab, before page fields can clear
    // the selection. Showing the card itself never moves keyboard focus.
    else if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
      && card && !card.button.disabled && document.activeElement !== card.host
      && sameSelection(readSelection(), currentSelection)) {
      event.preventDefault();
      card.button.focus();
    }
  }, true);
  // Capture scrolls in nested containers as well as scrolling the main document.
  document.addEventListener("scroll", () => dismiss(), true);
  window.addEventListener("resize", () => dismiss());
})();
