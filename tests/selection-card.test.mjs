import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import test from "node:test";
import { settle, storageMock } from "./helpers/storage.mjs";

const source = await readFile(new URL("../content-script/selection-card.js", import.meta.url), "utf8");
const consts = await readFile(new URL("../consts.js", import.meta.url), "utf8");
const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const cardId = "microburbs-facts-selection-card";

function page({ popover = true, loadStyles, save, childFrame = false } = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const frames = [];
  const messages = [];
  const errors = [];
  const fetches = [];
  let selection;
  const document = {
    activeElement: null,
    addEventListener(name, callback) { documentListeners.set(name, callback); },
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
    remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); }
    attachShadow() { this.shadowRoot = new Element(); this.shadowRoot.host = this; return this.shadowRoot; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    click() { return this.listeners.get("click")?.(); }
    showPopover() { this.open = true; }
    getBoundingClientRect() { return { width: 150, height: 60 }; }
    set innerHTML(_) { throw new Error("Do not render selection as HTML"); }
  }
  if (popover) Element.prototype.popover = "";
  document.documentElement = new Element("html");
  document.activeElement = document.documentElement;
  const textParent = new Element("p");
  const textNode = { nodeType: 3, parentElement: textParent };
  const window = { innerWidth: 800, innerHeight: 600,
    addEventListener(name, callback) { windowListeners.set(name, callback); },
    getSelection: () => selection,
  };
  window.top = childFrame ? {} : window;
  const chrome = { runtime: {
    getURL: path => `chrome-extension://test-extension/${path}`,
    async sendMessage(message) { messages.push(message); return save ? save(message) : { ok: true }; },
  } };
  const context = vm.createContext({ window, document, chrome,
    Node: { ELEMENT_NODE: 1 }, HTMLElement: Element,
    console: { error: (...args) => errors.push(args) },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    fetch: url => {
      fetches.push(url);
      return loadStyles ? loadStyles() : Promise.resolve({ ok: true, text: async () => "/* card styles */" });
    },
    CSSStyleSheet: class { replaceSync() {} },
  });
  vm.runInContext(consts, context);
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
    for (const callback of frames.splice(0)) callback();
    await settle();
  }
  return { document, window, messages, errors, fetches, textParent, context, chrome,
    card: () => document.documentElement.children.find(item => item.id === cardId),
    button: () => document.documentElement.children.find(item => item.id === cardId)?.shadowRoot.children[0],
    status: () => document.documentElement.children.find(item => item.id === cardId)?.shadowRoot.children[1].textContent,
    select, event, flush, clear: () => { selection = null; },
    resize: () => windowListeners.get("resize")(),
  };
}

test("page startup is inert, only top frame runs, repeated initialization has no duplicate listeners", async () => {
  const app = page();
  assert.equal(app.card(), undefined);
  assert.deepEqual(app.fetches, []);
  vm.runInContext(source, app.context);
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
  context.importScripts = () => vm.runInContext(consts, context);
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
