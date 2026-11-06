"use strict";

(() => {
  const widgetId = "microburbs-facts-widget";
  const controllerKey = "__microburbsFactsWidgetController";
  if (window.top !== window || globalThis[controllerKey] || document.getElementById(widgetId)) return;
  globalThis[controllerKey] = true;

  let pendingWidget;

  function showWidget() {
    if (pendingWidget) return pendingWidget;
    if (document.getElementById(widgetId)) return Promise.resolve();
    pendingWidget = createWidget().finally(() => { pendingWidget = undefined; });
    return pendingWidget;
  }

  async function createWidget() {
    const host = document.createElement("div");
    host.id = widgetId;
    host.lang = "en";
    host.dir = "ltr";
    host.hidden = true;
    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true });

    const widget = document.createElement("section");
    widget.setAttribute("aria-labelledby", "widget-title");
    const header = document.createElement("header");
    const title = document.createElement("h2");
    title.id = "widget-title";
    title.textContent = "Microburbs Facts";
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close Microburbs Facts widget");
    close.textContent = "×";
    close.addEventListener("click", () => host.remove());
    const message = document.createElement("p");
    message.textContent = "Your Microburbs Facts widget is ready.";

    header.append(title, close);
    widget.append(header, message);
    shadow.append(widget);
    document.documentElement.append(host);

    // Manifest CSS styles the host; adopt the same file for the shadow contents.
    try {
      const response = await fetch(chrome.runtime.getURL("content-script/content-script.css"));
      if (!response.ok) throw new Error(`Widget stylesheet failed to load (${response.status}).`);
      const css = await response.text();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      host.hidden = false;
    } catch (error) {
      host.remove();
      throw error;
    }
  }

  // Wait for the popup's explicit request before creating any widget DOM.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "SHOW_WIDGET") return;
    showWidget().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    // Keep the response channel open until the widget's styles have loaded.
    return true;
  });
})();
