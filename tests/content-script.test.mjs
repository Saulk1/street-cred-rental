import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../content-script/content-script.js", import.meta.url), "utf8");
const widgetId = "microburbs-facts-widget";
const stylesheet = () => ({ ok: true, text: async () => "/* bundled widget styles */" });

// Only the DOM operations used by the content script are needed for these
// lifecycle checks. Rendering, CSS isolation and keyboard behavior need Chrome.
class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  attachShadow() {
    this.shadowRoot = new Element("#shadow-root");
    return this.shadowRoot;
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  click() { this.listeners.get("click")?.(); }
}

function page(loadStyles = async () => stylesheet()) {
  const root = new Element("html");
  const created = [];
  const fetches = [];
  const listeners = [];
  const window = {};
  window.top = window;
  const document = {
    documentElement: root,
    getElementById: id => root.children.find(element => element.id === id) ?? null,
    createElement(tagName) {
      const element = new Element(tagName);
      created.push(element);
      return element;
    },
  };
  const chrome = {
    runtime: {
      getURL: path => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener: listener => listeners.push(listener) },
    },
  };
  vm.runInNewContext(source, {
    window, document, chrome,
    fetch(url) {
      fetches.push(url);
      return loadStyles();
    },
    CSSStyleSheet: class { replaceSync() {} },
  });
  return {
    root, created, fetches, listeners,
    widget: () => document.getElementById(widgetId),
    send(message = { type: "SHOW_WIDGET" }) {
      let respond;
      const response = new Promise(resolve => { respond = resolve; });
      const keepAlive = listeners[0](message, {}, result => respond({ ...result }));
      return { response, keepAlive };
    },
  };
}

test("page initialization and unrelated messages create no DOM or stylesheet requests", async () => {
  const app = page();
  assert.equal(app.listeners.length, 1);
  for (const message of [undefined, {}, { type: "OTHER_MESSAGE" }]) {
    assert.equal(app.listeners[0](message, {}, () => assert.fail("Unrelated message was handled")), undefined);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.created, []);
  assert.deepEqual(app.root.children, []);
  assert.deepEqual(app.fetches, []);
});

test("SHOW_WIDGET creates a visible widget and acknowledges success after loading styles", async () => {
  const app = page();
  const request = app.send();
  assert.equal(request.keepAlive, true);
  assert.deepEqual(await request.response, { ok: true });
  assert.equal(app.root.children.length, 1);
  assert.equal(app.widget().hidden, false);
  assert.deepEqual(app.fetches, ["chrome-extension://test-extension/content-script/content-script.css"]);
});

test("simultaneous and repeated show requests share one widget and stylesheet request", async () => {
  let resolveStyles;
  const styles = new Promise(resolve => { resolveStyles = resolve; });
  const app = page(() => styles);
  const first = app.send();
  const second = app.send();
  const widget = app.widget();
  assert.equal(widget.hidden, true);
  assert.equal(app.root.children.length, 1);
  assert.equal(app.fetches.length, 1);
  resolveStyles(stylesheet());
  assert.deepEqual(await Promise.all([first.response, second.response]), [{ ok: true }, { ok: true }]);
  assert.deepEqual(await app.send().response, { ok: true });
  assert.equal(app.root.children.length, 1);
  assert.equal(app.widget(), widget);
  assert.equal(app.fetches.length, 1);
});

test("closing the widget leaves it absent until another explicit show request", async () => {
  const app = page();
  await app.send().response;
  const firstWidget = app.widget();
  const close = app.created.find(element =>
    element.tagName === "button" && element.attributes.get("aria-label") === "Close Microburbs Facts widget");
  close.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.widget(), null);
  assert.equal(app.fetches.length, 1);
  assert.deepEqual(await app.send().response, { ok: true });
  assert.notEqual(app.widget(), firstWidget);
  assert.equal(app.widget().hidden, false);
  assert.equal(app.root.children.length, 1);
});

test("a new page document starts empty even after showing the widget on another page", async () => {
  const previousPage = page();
  await previousPage.send().response;
  const nextPage = page();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nextPage.widget(), null);
  assert.deepEqual(nextPage.created, []);
  assert.deepEqual(nextPage.fetches, []);
});

for (const [name, fail] of [
  ["a network failure", async () => { throw new Error("Stylesheet unavailable"); }],
  ["an HTTP failure", async () => ({ ok: false, status: 404 })],
]) {
  test(`${name} removes the incomplete widget, reports failure and allows retry`, async () => {
    let attempts = 0;
    const app = page(() => ++attempts === 1 ? fail() : stylesheet());
    assert.deepEqual(await app.send().response, { ok: false });
    assert.equal(app.widget(), null);
    assert.deepEqual(await app.send().response, { ok: true });
    assert.equal(app.root.children.length, 1);
    assert.equal(app.widget().hidden, false);
    assert.equal(app.fetches.length, 2);
  });
}
