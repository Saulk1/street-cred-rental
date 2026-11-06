import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import test from "node:test";
import { settle, storageMock } from "./helpers/storage.mjs";

const source = await readFile(new URL("../content-script/selection-card.js", import.meta.url), "utf8");
const consts = await readFile(new URL("../consts.js", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../property-api.js", import.meta.url), "utf8");
const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const lookupSource = await readFile(new URL("../content-script/property-lookup.js", import.meta.url), "utf8");
const cardId = "microburbs-facts-selection-card";

function page({ popover = true, loadStyles, save, childFrame = false, lookupAttach, missingLookup = false,
  popoverError } = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const frames = [];
  const messages = [];
  const errors = [];
  const warnings = [];
  const fetches = [];
  const signals = [];
  const runtimeListeners = new Set();
  let nextFrame = 0;
  const cancelledFrames = [];
  function register(listeners, name, callback, options) {
    listeners.set(name, callback);
    options?.signal?.addEventListener("abort", () => {
      if (listeners.get(name) === callback) listeners.delete(name);
    });
  }
  let selection;
  const document = {
    activeElement: null,
    addEventListener(name, callback, options) { register(documentListeners, name, callback, options); },
    createElement: tag => new Element(tag),
  };
  class Element {
    constructor(tag = "div") {
      this.tagName = tag;
      this.nodeType = 1;
      this.children = [];
      this.style = {};
      this.listeners = new Map();
      this.textContent = "";
      this.disabled = false;
      this.editable = false;
    }
    closest() { return this.editable || this.id === cardId || this.id === "microburbs-facts-widget" ? this : null; }
    matches() { return this.editable; }
    focus() { document.activeElement = this.parent?.host ?? this; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() {
      if (!this.parent) return;
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = undefined;
    }
    attachShadow() { this.shadowRoot = new Element(); this.shadowRoot.host = this; return this.shadowRoot; }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    click() { return this.listeners.get("click")?.(); }
    showPopover() { if (popoverError) throw popoverError; this.open = true; }
    getBoundingClientRect() { return { width: 150, height: 60 }; }
    set innerHTML(_) { throw new Error("Do not render selection as HTML"); }
  }
  if (popover) Element.prototype.popover = "";
  document.documentElement = new Element("html");
  document.activeElement = document.documentElement;
  const textParent = new Element("p");
  const textNode = { nodeType: 3, parentElement: textParent };
  const window = { innerWidth: 800, innerHeight: 600,
    addEventListener(name, callback, options) { register(windowListeners, name, callback, options); },
    getSelection: () => selection,
  };
  window.top = childFrame ? {} : window;
  const chrome = { runtime: {
    id: "test-extension",
    onMessage: {
      addListener: listener => runtimeListeners.add(listener),
      removeListener: listener => runtimeListeners.delete(listener),
    },
    getURL: path => `chrome-extension://test-extension/${path}`,
    async sendMessage(message) { messages.push(message); return save ? save(message) : { ok: true }; },
  } };
  const context = vm.createContext({ window, document, chrome,
    setTimeout, clearTimeout, AbortController,
    Node: { ELEMENT_NODE: 1 }, HTMLElement: Element,
    console: { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
    requestAnimationFrame: callback => { const id = ++nextFrame; frames.push({ id, callback }); return id; },
    cancelAnimationFrame(id) {
      cancelledFrames.push(id);
      const index = frames.findIndex(frame => frame.id === id);
      if (index !== -1) frames.splice(index, 1);
    },
    fetch: (url, options) => {
      fetches.push(url);
      signals.push(options.signal);
      return loadStyles ? loadStyles(url, options) : Promise.resolve({ ok: true, text: async () => "/* card styles */" });
    },
    CSSStyleSheet: class { replaceSync() {} },
  });
  vm.runInContext(consts, context);
  if (lookupAttach) {
    context.lookupAttach = lookupAttach;
    vm.runInContext("const PROPERTY_LOOKUP = { attach: lookupAttach };", context);
  } else if (!missingLookup) vm.runInContext(lookupSource, context);
  vm.runInContext(source, context);
  function select(text = "selected text", rect = { left: 100, top: 80, bottom: 100, width: 50, height: 20 }) {
    selection = { isCollapsed: false, rangeCount: 1,
      anchorNode: textNode, anchorOffset: 0, focusNode: textNode, focusOffset: text.length,
      toString: () => text,
      getRangeAt: () => ({ startContainer: textNode, startOffset: 0, getClientRects: () => [rect] }),
    };
    return selection;
  }
  const event = (name, values = {}) => documentListeners.get(name)?.({ button: 0, composedPath: () => [], ...values });
  async function flush() {
    for (const { callback } of frames.splice(0)) callback();
    await settle();
  }
  return { document, window, messages, errors, warnings, fetches, signals, cancelledFrames, runtimeListeners,
    receive: (message, sender = { id: "test-extension" }) => new Promise(resolve => {
      for (const listener of runtimeListeners) {
        const keepOpen = listener(message, sender, resolve);
        if (keepOpen === true) return;
      }
      resolve(undefined);
    }),
    documentListeners, windowListeners, textParent, context, chrome,
    card: () => document.documentElement.children.find(item => item.id === cardId),
    button: () => document.documentElement.children.find(item => item.id === cardId)?.shadowRoot.children[0],
    status: () => document.documentElement.children.find(item => item.id === cardId)?.shadowRoot.children[1].textContent,
    select, event, flush, clear: () => { selection = null; },
    resize: () => windowListeners.get("resize")?.(),
  };
}

test("page startup is inert, only top frame runs, repeated initialization has no duplicate listeners", async () => {
  const app = page();
  assert.equal(app.card(), undefined);
  assert.deepEqual(app.fetches, []);
  vm.runInContext(source, app.context);
  assert.equal(app.runtimeListeners.size, 1);
  app.select(); app.event("selectionchange"); await app.flush();
  assert.equal(app.document.documentElement.children.length, 1);
  assert.equal(app.fetches.length, 1);
  const child = page({ childFrame: true });
  child.select(); child.event("selectionchange"); await child.flush();
  assert.equal(child.card(), undefined);
});

test("mouse selection waits for pointer release; keyboard selection appears without stealing focus", async () => {
  const app = page();
  app.event("pointerdown"); app.select(); app.event("selectionchange"); await app.flush();
  assert.equal(app.card(), undefined);
  app.event("pointerup"); await app.flush();
  assert.equal(app.button().textContent, "Save to notes");
  assert.equal(app.card().open, true);
  assert.equal(app.document.activeElement, app.document.documentElement);
  app.select("keyboard selection"); app.event("selectionchange"); await app.flush();
  assert.equal(app.document.documentElement.children.length, 1);
  assert.equal(app.messages.length, 0);
});

test("blank and editable selections are ignored", async () => {
  const app = page();
  app.select(" \n "); app.event("selectionchange"); await app.flush();
  assert.equal(app.card(), undefined);
  app.textParent.editable = true;
  app.select("editable"); app.event("selectionchange"); await app.flush();
  assert.equal(app.card(), undefined);
  app.textParent.editable = false;
  const selection = app.select(); selection.isCollapsed = true;
  app.event("selectionchange"); await app.flush();
  assert.equal(app.card(), undefined);
});

test("click saves the snapshotted text, survives selection collapse, and blocks duplicate saves", async () => {
  let complete;
  const app = page({ save: () => new Promise(resolve => { complete = resolve; }) });
  const text = "  <b>literal</b>\n中文  ";
  app.select(text); app.event("selectionchange"); await app.flush();
  let prevented = false;
  app.button().listeners.get("pointerdown")({ button: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  app.clear(); // The button's snapshot must not depend on the live selection at click time.
  const saved = app.button().click();
  await app.button().click();
  assert.equal(app.messages.length, 1);
  assert.equal(app.messages[0].text, text);
  assert.equal(app.messages[0].type, "SAVE_SELECTION_NOTE");
  complete({ ok: true }); await saved;
  assert.equal(app.button().textContent, "Saved to notes");
  assert.equal(app.button().disabled, true);
  await app.button().click();
  assert.equal(app.messages.length, 1);
});

test("failed responses and rejected messaging retain text and allow retry", async () => {
  for (const failure of [async () => ({ ok: false }), async () => { throw new Error("Worker unavailable"); }]) {
    let saving = failure;
    const app = page({ save: message => saving(message) });
    app.select("retry me"); app.event("selectionchange"); await app.flush();
    await app.button().click();
    assert.equal(app.button().disabled, false);
    assert.match(app.status(), /Could not save/);
    saving = async () => ({ ok: true });
    await app.button().click();
    assert.equal(app.messages[1].text, "retry me");
    assert.equal(app.button().disabled, true);
  }
});

test("Escape, outside clicks, scrolling and resize dismiss until selection changes", async () => {
  for (const dismiss of [app => app.event("keydown", { key: "Escape" }),
    app => { app.event("pointerdown"); app.event("pointerup"); },
    app => app.event("scroll"), app => app.resize()]) {
    const app = page();
    app.select(); app.event("selectionchange"); await app.flush();
    dismiss(app); await app.flush();
    assert.equal(app.card(), undefined);
    app.event("selectionchange"); await app.flush();
    assert.equal(app.card(), undefined);
    app.select("new selection"); app.event("selectionchange"); await app.flush();
    assert.ok(app.card());
  }
});

test("clicks inside the card do not dismiss it; selection clearing removes it", async () => {
  const app = page();
  app.select(); app.event("selectionchange"); await app.flush();
  const host = app.card();
  app.event("pointerdown", { composedPath: () => [app.button(), host] });
  assert.equal(app.card(), host);
  app.clear(); app.event("selectionchange"); await app.flush();
  assert.equal(app.card(), undefined);
});

test("the card flips and clamps at viewport edges and uses the fixed-position fallback", async () => {
  const app = page({ popover: false });
  app.select("edge", { left: 780, top: 570, bottom: 590, width: 20, height: 20 });
  app.event("selectionchange"); await app.flush();
  assert.equal(app.card().open, undefined);
  assert.equal(app.card().style.left, "642px");
  assert.equal(app.card().style.top, "502px");
  app.select("left", { left: -10, top: 0, bottom: 20, width: 20, height: 20 });
  app.event("selectionchange"); await app.flush();
  assert.equal(app.card().style.left, "8px");
  assert.equal(app.card().style.top, "28px");
});

test("multiline selections anchor near the focus end, including backward selection", async () => {
  const app = page();
  const selection = app.select("two lines");
  const rects = [
    { left: 10, top: 20, bottom: 40, width: 80, height: 20 },
    { left: 30, top: 40, bottom: 60, width: 80, height: 20 },
  ];
  selection.getRangeAt = () => ({ startContainer: selection.anchorNode, startOffset: 0, getClientRects: () => rects });
  app.event("selectionchange"); await app.flush();
  assert.equal(app.card().style.top, "68px");
  selection.anchorOffset = 9; selection.focusOffset = 0;
  app.event("selectionchange"); await app.flush();
  assert.equal(app.card().style.top, "48px");
});

test("a stale save response cannot change a newer card", async () => {
  let complete;
  const app = page({ save: () => new Promise(resolve => { complete = resolve; }) });
  app.select("first"); app.event("selectionchange"); await app.flush();
  const saving = app.button().click();
  app.select("second"); app.event("selectionchange"); await app.flush();
  complete({ ok: true }); await saving;
  assert.equal(app.button().textContent, "Save to notes");
  assert.equal(app.button().disabled, false);
  assert.equal(app.status(), "");
});

test("dismissal during stylesheet loading prevents a late card, and loading failures can retry", async () => {
  let complete;
  const app = page({ loadStyles: () => new Promise(resolve => { complete = resolve; }) });
  app.select(); app.event("selectionchange"); await app.flush();
  app.event("keydown", { key: "Escape" });
  complete({ ok: true, text: async () => "/* css */" }); await app.flush();
  assert.equal(app.card(), undefined);
  let fail = true;
  const retry = page({ loadStyles: async () => ({ ok: !fail, text: async () => "/* css */" }) });
  retry.select(); retry.event("selectionchange"); await retry.flush();
  assert.equal(retry.card(), undefined);
  assert.equal(retry.errors.length, 1);
  fail = false;
  retry.select("retry"); retry.event("selectionchange"); await retry.flush();
  assert.ok(retry.card());
});

test("native popover dismissal and keyboard focus inside the card retain correct selection state", async () => {
  const app = page();
  app.select(); app.event("selectionchange"); await app.flush();
  const host = app.card();
  host.focus();
  app.clear(); app.event("selectionchange"); await app.flush();
  assert.equal(app.card(), host);
  host.listeners.get("toggle")({ newState: "closed" });
  assert.equal(app.card(), undefined);
  assert.equal(app.document.activeElement, app.document.documentElement);
});

test("Tab enters the selection action before page fields can clear it, Escape restores page focus", async () => {
  const app = page();
  app.select(); app.event("selectionchange"); await app.flush();
  const previousFocus = app.document.activeElement;
  let prevented = false;
  app.event("keydown", { key: "Tab", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(app.document.activeElement, app.card());
  app.clear(); app.event("selectionchange"); await app.flush();
  assert.ok(app.card());
  app.event("keydown", { key: "Escape" });
  assert.equal(app.document.activeElement, previousFocus);
  assert.equal(app.card(), undefined);
});

test("a card click reaches the real background handler and publishes a local storage change", async () => {
  const store = storageMock();
  let onMessage;
  const context = vm.createContext({ chrome: {
    storage: store.storage,
    runtime: { id: "test-extension", onMessage: { addListener: listener => { onMessage = listener; } },
      onInstalled: { addListener() {} } },
    contextMenus: { onClicked: { addListener() {} } },
  }, crypto: { randomUUID }, console });
  context.importScripts = path => {
    if (path === "consts.js") vm.runInContext(consts, context);
    else if (path === "property-api.js") vm.runInContext(apiSource, context);
    else throw new Error("Missing generated configuration");
  };
  vm.runInContext(background, context);
  let changed;
  store.storage.onChanged.addListener(changes => { changed = changes; });
  const app = page({ save: message => new Promise(resolve => {
    onMessage(message, { id: "test-extension", frameId: 0, tab: { id: 7 }, url: "https://example.com" }, resolve);
  }) });
  app.select("Captured from card"); app.event("selectionchange"); await app.flush();
  await app.button().click();
  const [saved] = Object.values(store.data);
  assert.equal(saved.text, "Captured from card");
  assert.equal(saved.type, "selection");
  assert.equal(Object.keys(changed)[0], `microburbs.note.${saved.id}`);
});

const propertyReply = () => ({ ok: true, sections: {
  basics: { status: "ok", data: { dwelling_type: "house", bed_count: 0, bath_count: null, parking_count: 1, land_area_sqm: 120 } },
  valuation: { status: "ok", data: { predicted_price: 1200000, predicted_price_low: 1000000, predicted_price_high: 1400000,
    prediction_date: "2026-04-20", confidence_score: 70 } },
  risks: { status: "ok", data: {
    bushfire: [{ on_property: true, nearest_distance_m: 0 }],
    flood: [{ on_property: false, nearest_distance_m: 257 }], historical_flood: null, heritage: [],
    hv_power_line: [{ on_property: false, nearest_distance_m: 100 }],
    public_housing: [{ on_property: true, value: "3.4%", value_unit: "Properties Proportion", nearest_distance_m: 0 }],
  } },
} });
const allText = node => [node.textContent, ...node.children.map(allText)].join(" ");
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const lookupButton = app => app.card().shadowRoot.children[2];
const panel = app => app.card().shadowRoot.children[4];
const candidate = (id = "GANSW1", label = "26 Tudor Street, Surry Hills") => ({ id, label });

test("context lookup restores a dismissed card from the native-menu snapshot and starts search", async () => {
  const app = page({ save: message => message.type === "SEARCH_ADDRESS"
    ? { ok: true, candidates: [candidate()] } : propertyReply() });
  const text = "26 Tudor Street, Surry Hills";
  app.select(text); app.event("selectionchange"); await app.flush();
  app.event("pointerdown", { button: 2 });
  app.event("contextmenu", { target: app.textParent });
  app.clear(); app.event("selectionchange"); await app.flush();
  assert.equal(app.card(), undefined);
  const result = await app.receive({ type: "LOOK_UP_SELECTION", text });
  await app.flush();
  assert.equal(result.ok, true);
  assert.deepEqual(app.messages.map(message => message.type), ["SEARCH_ADDRESS", "PROPERTY_DETAILS"]);
  assert.equal(app.messages[0].address, text);
  assert.match(allText(panel(app)), /\$1,200,000/);
  assert.equal((await app.receive({ type: "LOOK_UP_SELECTION", text })).ok, false);
  assert.equal(app.messages.length, 2);
});

test("context lookup rejects untrusted messages, changed selections and editable targets", async () => {
  const text = "26 Tudor Street, Surry Hills";
  for (const scenario of ["sender", "sender-tab", "missing-snapshot", "mismatch", "editable", "new-selection", "outside", "escape"]) {
    const app = page();
    app.select(text);
    if (scenario === "editable") app.textParent.editable = true;
    if (scenario !== "missing-snapshot") app.event("contextmenu", { target: app.textParent });
    if (scenario === "new-selection") { app.select("another address"); app.event("selectionchange"); await app.flush(); }
    if (scenario === "outside") app.event("pointerdown");
    if (scenario === "escape") app.event("keydown", { key: "Escape" });
    const sender = scenario === "sender" ? { id: "other-extension" }
      : scenario === "sender-tab" ? { id: "test-extension", tab: { id: 2 } } : undefined;
    const result = await app.receive({ type: "LOOK_UP_SELECTION", text: scenario === "mismatch" ? "different" : text }, sender);
    assert.equal(result.ok, false, scenario);
    assert.deepEqual(app.messages, [], scenario);
  }
});

test("new interaction during context lookup style loading cancels the pending card", async () => {
  let finish;
  const app = page({ loadStyles: () => new Promise(resolve => { finish = resolve; }) });
  const text = "26 Tudor Street, Surry Hills";
  app.select(text); app.event("contextmenu", { target: app.textParent });
  const reply = app.receive({ type: "LOOK_UP_SELECTION", text });
  app.event("pointerdown");
  finish({ ok: true, text: async () => "/* css */" });
  assert.equal((await reply).ok, false);
  assert.equal(app.card(), undefined);
  assert.deepEqual(app.messages, []);
});

test("a repeated native-menu lookup supersedes pending results from the previous address", async () => {
  let finishOld;
  const app = page({ save: message => message.address === "old address"
    ? new Promise(resolve => { finishOld = resolve; }) : { ok: true, candidates: [] } });
  app.select("old address"); app.event("contextmenu", { target: app.textParent });
  assert.equal((await app.receive({ type: "LOOK_UP_SELECTION", text: "old address" })).ok, true);
  app.event("pointerdown", { button: 2 });
  app.select("new address"); app.event("contextmenu", { target: app.textParent });
  assert.equal((await app.receive({ type: "LOOK_UP_SELECTION", text: "new address" })).ok, true);
  await app.flush();
  finishOld({ ok: true, candidates: [candidate()] });
  await app.flush();
  assert.equal(app.messages.length, 2);
  assert.equal(app.messages[1].address, "new address");
  assert.match(allText(panel(app)), /No matching addresses/);
});

async function propertyPage(handler) {
  const app = page({ save: handler });
  app.select("26 Tudor St\nSurry Hills"); app.event("selectionchange"); await app.flush();
  return app;
}

test("a single address match automatically loads facts, estimates and correctly labelled overlays", async () => {
  const app = await propertyPage(message => message.type === "SEARCH_ADDRESS"
    ? { ok: true, candidates: [candidate()] } : propertyReply());
  await lookupButton(app).click();
  assert.deepEqual(app.messages.map(message => message.type), ["SEARCH_ADDRESS", "PROPERTY_DETAILS"]);
  const text = allText(panel(app));
  for (const label of ["26 Tudor Street", "GNAF: GANSW1", "Bedrooms 0", "Bathrooms Not available", "$1,200,000", "80% prediction interval",
    "2026-04-20", "Overlay at the property's address point", "Not at the property's address point; nearest 257 m away",
    "Nearby feature; nearest 100 m away", "Neighbourhood context", "3.4%", "planning certificate"]) assert.ok(text.includes(label), label);
  assert.equal(app.document.activeElement, app.card());
});

test("multiple matches require a choice and support returning to the candidate list", async () => {
  const app = await propertyPage(message => message.type === "SEARCH_ADDRESS"
    ? { ok: true, candidates: [candidate(), candidate("GANSW2", "Unit 2/26 Tudor Street")] } : propertyReply());
  await lookupButton(app).click();
  assert.equal(app.messages.length, 1);
  const choices = descendants(panel(app)).filter(node => node.tagName === "button");
  assert.equal(choices.length, 2);
  await choices[1].click();
  assert.equal(app.messages[1].id, "GANSW2");
  const back = descendants(panel(app)).find(node => node.textContent === "Choose another match");
  back.click();
  assert.ok(allText(panel(app)).includes("Choose the matching address"));
});

test("no matches and missing configuration have useful feedback without breaking note saves", async () => {
  const app = await propertyPage(() => ({ ok: true, candidates: [] }));
  await lookupButton(app).click();
  assert.ok(allText(panel(app)).includes("City of Sydney"));
  const missing = await propertyPage(message => message.type === "SEARCH_ADDRESS"
    ? { ok: false, error: { code: "configuration", message: "Set the key in .env.local and rebuild." } } : { ok: true });
  await lookupButton(missing).click();
  assert.ok(allText(panel(missing)).includes(".env.local"));
  assert.equal(lookupButton(missing).disabled, false);
  await missing.button().click();
  assert.equal(missing.button().textContent, "Saved to notes");
});

test("partial section failures retain property facts and expose a retry", async () => {
  const result = propertyReply();
  result.sections.valuation = { status: "error", error: { message: "Valuation unavailable", requestId: "support-id" } };
  result.sections.risks = { status: "empty" };
  const app = await propertyPage(message => message.type === "SEARCH_ADDRESS" ? { ok: true, candidates: [candidate()] } : result);
  await lookupButton(app).click();
  const text = allText(panel(app));
  assert.ok(text.includes("Bedrooms 0"));
  assert.ok(text.includes("Valuation unavailable"));
  assert.ok(text.includes("Request ID: support-id"));
  assert.ok(descendants(panel(app)).some(node => node.textContent === "Retry"));
});

test("dismissed or newer selections ignore address lookup replies; internal scrolling stays usable", async () => {
  let complete;
  const app = await propertyPage(() => new Promise(resolve => { complete = resolve; }));
  const loading = lookupButton(app).click();
  await lookupButton(app).click();
  assert.equal(app.messages.length, 1);
  app.event("scroll", { composedPath: () => [app.card()] });
  assert.ok(app.card());
  app.select("another address"); app.event("selectionchange"); await app.flush();
  complete({ ok: true, candidates: [candidate()] }); await loading;
  assert.equal(panel(app).children.length, 0);
  assert.equal(app.messages.length, 1);
});

test("rate-limit retry stays disabled until Retry-After", async () => {
  const app = await propertyPage(() => ({ ok: false, error: { message: "Rate limited", retryAt: Date.now() + 30 } }));
  await lookupButton(app).click();
  const retry = descendants(panel(app)).find(node => node.textContent === "Retry");
  assert.equal(retry.disabled, true);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(retry.disabled, false);
});

test("invalid runtime before startup stops listeners and reports webpage reload only once", async () => {
  const app = page();
  app.chrome.runtime.id = undefined;
  app.select(); app.event("selectionchange"); await app.flush();
  assert.equal(app.card(), undefined);
  assert.equal(app.fetches.length, 0);
  assert.equal(app.documentListeners.size, 0);
  assert.equal(app.windowListeners.size, 0);
  assert.equal(app.errors.length, 1);
  assert.match(app.errors[0][0], /extension was reloaded.*Reload this webpage/);
  app.select("another selection"); app.event("selectionchange"); app.resize(); await app.flush();
  assert.equal(app.errors.length, 1);
});

test("an invalidated getURL is recognised even when the old runtime id is present", async () => {
  const app = page();
  app.chrome.runtime.getURL = () => { throw new Error("Extension context invalidated."); };
  app.select(); app.event("selectionchange"); await app.flush();
  assert.equal(app.card(), undefined);
  assert.equal(app.fetches.length, 0);
  assert.equal(app.errors.length, 1);
  assert.match(app.errors[0][0], /Reload this webpage/);
  assert.equal(app.documentListeners.size, 0);
});

test("invalidation during stylesheet loading cancels queued work and aborts loading", async () => {
  let rejectStyle;
  const app = page({ loadStyles: () => new Promise((resolve, reject) => { rejectStyle = reject; }) });
  app.select("first"); app.event("selectionchange"); await app.flush();
  app.select("second"); app.event("selectionchange");
  app.chrome.runtime.id = undefined;
  rejectStyle(new Error("Extension context invalidated."));
  await settle();
  assert.equal(app.signals[0].aborted, true);
  assert.equal(app.cancelledFrames.length, 1);
  assert.equal(app.documentListeners.size, 0);
  await app.flush();
  assert.equal(app.card(), undefined);
  assert.equal(app.errors.length, 1);
  assert.equal(app.fetches.length, 1);
});

test("runtime is checked again after asynchronous styles finish", async () => {
  let resolveStyle;
  const app = page({ loadStyles: () => new Promise(resolve => { resolveStyle = resolve; }) });
  app.select(); app.event("selectionchange"); await app.flush();
  app.chrome.runtime.id = undefined;
  resolveStyle({ ok: true, text: async () => "/* styles */" });
  await settle();
  assert.equal(app.card(), undefined);
  assert.equal(app.errors.length, 1);
  assert.equal(app.signals[0].aborted, true);
});

test("cached styles do not let stale controllers create new cards", async () => {
  const app = page();
  app.select(); app.event("selectionchange"); await app.flush();
  const original = app.card();
  app.chrome.runtime.id = undefined;
  app.select("changed selection"); app.event("selectionchange"); await app.flush();
  assert.equal(app.card(), undefined);
  assert.equal(original.parent, undefined);
  assert.equal(app.errors.length, 1);
  assert.equal(app.fetches.length, 1);
});

test("saving after invalidation removes the current card and stops its controller", async () => {
  const app = page();
  app.select(); app.event("selectionchange"); await app.flush();
  app.chrome.runtime.id = undefined;
  await app.button().click();
  assert.equal(app.card(), undefined);
  assert.equal(app.messages.length, 0);
  assert.equal(app.documentListeners.size, 0);
  assert.equal(app.errors.length, 1);
});

test("missing lookup module does not prevent note saving or keyboard navigation", async () => {
  const app = page({ missingLookup: true });
  app.select(); app.event("selectionchange"); await app.flush();
  assert.ok(app.card());
  assert.equal(app.card().shadowRoot.children.length, 2);
  assert.match(app.status(), /lookup is unavailable/);
  assert.match(app.warnings[0][0], /property-lookup attachment \(ReferenceError\)/);
  assert.equal(app.errors.length, 0);
  let focused = false;
  app.event("keydown", { key: "Tab", preventDefault() { focused = true; } });
  assert.equal(focused, true);
  await app.button().click();
  assert.equal(app.button().textContent, "Saved to notes");
  app.event("keydown", { key: "Tab" }); // No lookup button exists after saving.
});

test("partially attached lookup controls are removed and selected data never enters diagnostics", async () => {
  const secret = "private selected address and key";
  const app = page({ lookupAttach({ host, shadow }) {
    host.setAttribute("data-expanded", "true");
    shadow.append(app.document.createElement("button"), app.document.createElement("section"));
    throw new TypeError(secret);
  } });
  app.select(secret); app.event("selectionchange"); await app.flush();
  assert.equal(app.card().shadowRoot.children.length, 2);
  assert.equal(Object.hasOwn(app.card(), "data-expanded"), false);
  assert.match(app.warnings[0][0], /property-lookup attachment \(TypeError\)/);
  assert.ok(!JSON.stringify(app.warnings).includes(secret));
  await app.button().click();
  assert.equal(app.messages[0].text, secret);
});

test("native popover failures use a visible fallback and ignore queued close events", async () => {
  const app = page({ popoverError: Object.assign(new Error("private page details"), { name: "InvalidStateError" }) });
  app.select(); app.event("selectionchange"); await app.flush();
  const host = app.card();
  assert.ok(host);
  assert.equal(Object.hasOwn(host, "popover"), false);
  assert.equal(host.style.left, "100px");
  assert.match(app.warnings[0][0], /popover opening \(InvalidStateError\).*fixed-position/);
  assert.ok(!JSON.stringify(app.warnings).includes("private"));
  host.listeners.get("toggle")({ newState: "closed" });
  assert.equal(app.card(), host);
  let focused = false;
  app.event("keydown", { key: "Tab", preventDefault() { focused = true; } });
  assert.equal(focused, true);
  app.event("keydown", { key: "Escape" });
  assert.equal(app.card(), undefined);
  app.select("new selection"); app.event("selectionchange"); await app.flush();
  assert.ok(app.card());
  assert.equal(app.warnings.length, 1);
  app.event("pointerdown");
  assert.equal(app.card(), undefined);
});

test("stylesheet failure diagnostics identify the stage without leaking exception text, and retry works", async () => {
  let fail = true;
  const app = page({ loadStyles: async () => {
    if (fail) throw new TypeError("private address in a request URL");
    return { ok: true, text: async () => "/* styles */" };
  } });
  app.select(); app.event("selectionchange"); await app.flush();
  assert.match(app.errors[0][0], /stylesheet loading \(TypeError\).*bundled card styles/);
  assert.ok(!JSON.stringify(app.errors).includes("private address"));
  fail = false;
  app.select("retry"); app.event("selectionchange"); await app.flush();
  assert.ok(app.card());
  assert.equal(app.fetches.length, 2);
});

test("insertion failures and cleanup exceptions leave no orphaned card and remain retryable", async () => {
  const app = page({ lookupAttach: () => ({ button: { disabled: false }, dispose() { throw new Error("private cleanup"); } }) });
  const root = app.document.documentElement;
  const append = root.append.bind(root);
  root.append = (...children) => { append(...children); throw new Error("private insertion"); };
  app.select(); app.event("selectionchange"); await app.flush();
  assert.equal(app.card(), undefined);
  assert.equal(root.children.length, 0);
  assert.ok(app.errors.some(([message]) => message.includes("card insertion")));
  assert.ok(app.errors.some(([message]) => message.includes("lookup cleanup")));
  assert.ok(!JSON.stringify(app.errors).includes("private"));
  root.append = append;
  app.select("retry"); app.event("selectionchange"); await app.flush();
  assert.ok(app.card());
  root.focus = () => { throw new Error("focus unavailable"); };
  app.card().focus();
  app.event("keydown", { key: "Escape" });
  assert.equal(root.children.length, 0);
  app.event("keydown", { key: "Escape" });
  assert.equal(root.children.length, 0);
});
