"use strict";

(() => {
  const controllerKey = "__microburbsFactsSelectionController";
  const cardId = "microburbs-facts-selection-card";
  if (window.top !== window || globalThis[controllerKey]) return;
  globalThis[controllerKey] = true;

  let card;
  let currentSelection;
  let dismissedSelection;
  let contextSelection;
  let selecting = false;
  let frame;
  let version = 0;
  let stylesheet;
  let styleRequest;
  let stopped = false;
  let popoverUnavailable = false;
  const listeners = new AbortController();

  // Only names from this allowlist reach diagnostics. Error messages can contain
  // page content or request details and must not be logged.
  function report(stage, error, recovery, recovered = false) {
    const names = ["Error", "TypeError", "ReferenceError", "SecurityError", "InvalidStateError",
      "NotAllowedError", "NotSupportedError", "NetworkError", "AbortError", "RangeError", "SyntaxError"];
    const name = names.includes(error?.name) ? error.name : "Error";
    console[recovered ? "warn" : "error"](`Selection card failed during ${stage} (${name}). ${recovery}`);
  }

  function invalidated(error) {
    return !chrome.runtime?.id || /Extension context invalidated/i.test(error?.message ?? "");
  }

  function stylesheetUrl() {
    if (!chrome.runtime?.id) throw new Error("Extension context invalidated");
    // getURL also detects orphaned contexts where a previously cached sheet
    // would otherwise let the old controller keep creating unusable cards.
    return chrome.runtime.getURL("content-script/selection-card.css");
  }

  function stopForInvalidContext() {
    if (stopped) return;
    stopped = true;
    listeners.abort();
    chrome.runtime.onMessage.removeListener(onLookupSelection);
    contextSelection = undefined;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    styleRequest?.abort();
    dismiss(false);
    dismissedSelection = undefined;
    stylesheet = undefined;
    console.error("The extension was reloaded. Reload this webpage to restore the selection card.");
  }

  function listen(target, type, callback, capture = false) {
    target.addEventListener(type, callback, { capture, signal: listeners.signal });
  }

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
      const { host, lookup, previousFocus } = card;
      card = undefined;
      try { lookup?.dispose(); } catch (error) {
        report("lookup cleanup", error, "The selection card was removed.");
      }
      try {
        if (document.activeElement === host && previousFocus?.isConnected !== false) {
          previousFocus?.focus({ preventScroll: true });
        }
      } catch { /* A removed or unfocusable page element must not prevent cleanup. */ }
      finally { host.remove(); }
    }
    currentSelection = undefined;
  }

  function loadStyles(url) {
    if (!stylesheet) {
      styleRequest = new AbortController();
      stylesheet = (async () => {
        const response = await fetch(url, { signal: styleRequest.signal });
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
    if (stopped) return;
    dismiss(false);
    currentSelection = selection;
    const requestedVersion = version;
    let stage = "extension-context check";
    let host;
    try {
      const url = stylesheetUrl();
      stage = "stylesheet loading";
      const sheet = await loadStyles(url);
      if (requestedVersion !== version || stopped) return;
      stage = "extension-context check";
      stylesheetUrl();
      stage = "Shadow DOM creation";
      host = document.createElement("div");
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
      let lookup;
      try {
        stage = "property-lookup attachment";
        lookup = PROPERTY_LOOKUP.attach({ host, shadow, selection,
          isCurrent: () => card?.host === host, reposition: () => position(host, selection.rect) });
      } catch (error) {
        if (invalidated(error)) throw error;
        for (const child of [...shadow.children]) {
          if (child !== button && child !== status) child.remove();
        }
        host.removeAttribute("data-expanded");
        status.textContent = "Property lookup is unavailable. You can still save notes. Reload this webpage to retry lookup.";
        report(stage, error, "Save to notes is still available; reload this webpage to retry lookup.", true);
      }
      stage = "card setup";
      // A mouse click should not collapse the selection or move page focus.
      button.addEventListener("pointerdown", event => {
        if (event.button === 0) event.preventDefault();
      });
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        status.textContent = "";
        try {
          stylesheetUrl();
          const response = await chrome.runtime.sendMessage({
            type: NOTEPAD.MESSAGES.SAVE_SELECTION_NOTE, text: selection.text,
          });
          if (!response?.ok) throw new Error("Save unavailable.");
          if (card?.host !== host) return;
          button.textContent = "Saved to notes";
          status.textContent = "Note saved.";
        } catch (error) {
          if (invalidated(error)) { stopForInvalidContext(); return; }
          if (card?.host !== host) return;
          button.disabled = false;
          status.textContent = "Could not save. Try again.";
        }
        if (card?.host === host) position(host, selection.rect);
      });
      card = { host, button, lookup, previousFocus: document.activeElement, nativePopover: false };
      stage = "card insertion";
      document.documentElement.append(host);
      const usePopover = !popoverUnavailable && "popover" in HTMLElement.prototype && typeof host.showPopover === "function";
      if (usePopover) {
        stage = "popover opening";
        try {
          host.popover = "auto";
          host.addEventListener("toggle", event => {
            if (event.newState === "closed" && card?.host === host && card.nativePopover) dismiss();
          });
          host.showPopover();
          card.nativePopover = true;
        } catch (error) {
          if (invalidated(error)) throw error;
          popoverUnavailable = true;
          card.nativePopover = false;
          // The CSS hides closed popovers. Removing the attribute is essential
          // before falling back, and queued close events must not dismiss it.
          host.removeAttribute("popover");
          report(stage, error, "Using the fixed-position selection card instead.", true);
        }
      }
      stage = "card positioning";
      position(host, selection.rect);
      return card;
    } catch (error) {
      if (invalidated(error)) { stopForInvalidContext(); host?.remove(); return; }
      if (requestedVersion === version) {
        dismiss(false);
        host?.remove();
        report(stage, error, stage === "stylesheet loading"
          ? "Could not load bundled card styles. Reload the extension and this webpage, then retry."
          : "Reload this webpage and select text again to retry.");
      }
    }
  }

  function update() {
    frame = undefined;
    if (stopped) return;
    if (selecting || (card && document.activeElement === card.host)) return;
    const selection = readSelection();
    if (selection && contextSelection && !sameSelection(selection, contextSelection)) contextSelection = undefined;
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
    if (stopped) return;
    if (frame === undefined) frame = requestAnimationFrame(update);
  }

  listen(document, "selectionchange", scheduleUpdate);
  // The native menu can dismiss the popover and collapse the live selection.
  // Keep only its address snapshot until a new page interaction supersedes it.
  listen(document, "contextmenu", event => {
    contextSelection = excluded(event.target) ? undefined : readSelection();
  }, true);
  function onLookupSelection(message, sender, sendResponse) {
    if (message?.type !== NOTEPAD.MESSAGES.LOOK_UP_SELECTION) return;
    const selection = contextSelection;
    if (stopped || sender.id !== chrome.runtime.id || sender.tab
      || typeof message.text !== "string" || message.text.trim().length < 2 || message.text.length > 1000
      || !selection || selection.text.trim() !== message.text.trim()) {
      sendResponse({ ok: false });
      return;
    }
    contextSelection = undefined;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    selecting = false;
    show({ ...selection, text: message.text }).then(created => {
      if (!created?.lookup?.start || card !== created) { sendResponse({ ok: false }); return; }
      void created.lookup.start().catch(error => {
        report("context-menu lookup", error, "Select the address and retry lookup.");
      });
      sendResponse({ ok: true });
    }, () => sendResponse({ ok: false }));
    return true;
  }
  chrome.runtime.onMessage.addListener(onLookupSelection);
  listen(document, "pointerdown", event => {
    if (card && event.composedPath().includes(card.host)) return;
    contextSelection = undefined;
    selecting = event.button === 0;
    dismiss();
  }, true);
  listen(document, "pointerup", () => { selecting = false; scheduleUpdate(); });
  listen(document, "pointercancel", () => { selecting = false; dismiss(); });
  listen(document, "keydown", event => {
    if (event.key === "Escape") { contextSelection = undefined; dismiss(); }
    // Offer the contextual action on the next Tab, before page fields can clear
    // the selection. Showing the card itself never moves keyboard focus.
    else if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
      && card && (!card.button.disabled || (card.lookup && !card.lookup.button.disabled)) && document.activeElement !== card.host
      && sameSelection(readSelection(), currentSelection)) {
      event.preventDefault();
      (card.button.disabled ? card.lookup.button : card.button).focus();
    }
  }, true);
  // Capture scrolls in nested containers as well as scrolling the main document.
  listen(document, "scroll", event => {
    if (!card || !event.composedPath().includes(card.host)) { contextSelection = undefined; dismiss(); }
  }, true);
  listen(window, "resize", () => { contextSelection = undefined; dismiss(); });
})();
