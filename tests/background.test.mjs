import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { note, noteKey, storageMock } from "./helpers/storage.mjs";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
const consts = await readFile(new URL("../consts.js", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../property-api.js", import.meta.url), "utf8");
const welcomeURL = "chrome-extension://test-extension/welcome/welcome.html";

function background(createTab = async () => ({ id: 1 }), store = storageMock(), menuFailure) {
  const listeners = [];
  const calls = [];
  const paths = [];
  const errors = [];
  const menus = new Map();
  const clickListeners = [];
  const messageListeners = [];
  const tabMessages = [];
  const chrome = {
    storage: store.storage,
    contextMenus: {
      onClicked: { addListener: listener => clickListeners.push(listener) },
      removeAll(callback) {
        menus.clear();
        chrome.runtime.lastError = menuFailure ? { message: "Menu API unavailable" } : undefined;
        callback();
        chrome.runtime.lastError = undefined;
      },
      create(properties, callback) {
        assert.ok(!menus.has(properties.id), "menu IDs must be unique");
        menus.set(properties.id, properties);
        callback();
      },
    },
    runtime: {
      id: "test-extension",
      onMessage: { addListener: listener => messageListeners.push(listener) },
      onInstalled: { addListener: listener => listeners.push(listener) },
      getURL(path) {
        paths.push(path);
        return `chrome-extension://test-extension/${path}`;
      },
    },
    tabs: {
      async sendMessage(tabId, message, options) {
        tabMessages.push({ tabId, message, options });
        return { ok: true };
      },
      create({ url, active }) {
        calls.push({ url, active });
        return createTab();
      },
    },
  };
  const context = vm.createContext({ chrome, URLSearchParams, AbortController, setTimeout, clearTimeout,
    crypto: { randomUUID }, console: { error: (...args) => errors.push(args) } });
  context.importScripts = path => {
    if (path === "consts.js") vm.runInContext(consts, context);
    else if (path === "property-api.js") vm.runInContext(apiSource, context);
    else throw new Error("Missing generated configuration");
  };
  vm.runInContext(source, context);
  return { listeners, calls, paths, errors, menus, clickListeners, store, chrome, tabMessages,
    message: (message, sender, respond) => messageListeners[0](message, sender, respond),
    click: (info, tab) => clickListeners[0](info, tab),
    install: reason => Promise.all(listeners.map(listener => listener({ reason }))) };
}

test("worker startup registers the install listener without opening a tab", () => {
  const app = background();
  assert.equal(app.listeners.length, 2);
  assert.equal(app.clickListeners.length, 1);
  assert.equal(app.menus.size, 0);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.paths, []);
});

const cardSender = { id: "test-extension", frameId: 0, tab: { id: 7 }, url: "https://example.com" };

test("a selection-card message responds only after the note is persisted", async () => {
  const app = background();
  let respond;
  const response = new Promise(resolve => { respond = resolve; });
  assert.equal(app.message({ type: "SAVE_SELECTION_NOTE", text: "  中文\n<b>text</b>  " }, cardSender, respond), true);
  assert.equal((await response).ok, true);
  const [saved] = Object.values(app.store.data);
  assert.equal(saved.text, "  中文\n<b>text</b>  ");
  assert.equal(saved.type, "selection");
  assert.ok(app.store.data[noteKey(saved.id)]);
});

test("card messages validate payload and sender and ignore unrelated messages", () => {
  const app = background();
  let calls = 0;
  assert.equal(app.message({ type: "OTHER" }, cardSender, () => calls++), undefined);
  assert.equal(calls, 0);
  for (const sender of [
    { ...cardSender, id: "other-extension" }, { ...cardSender, frameId: 1 },
    { ...cardSender, tab: undefined }, { ...cardSender, url: "chrome://settings" },
  ]) {
    app.message({ type: "SAVE_SELECTION_NOTE", text: "text" }, sender, response => {
      calls++;
      assert.equal(response.ok, false);
    });
  }
  for (const text of [undefined, 123, "", " \n "]) {
    app.message({ type: "SAVE_SELECTION_NOTE", text }, cardSender, response => {
      calls++;
      assert.equal(response.ok, false);
    });
  }
  assert.equal(calls, 8);
  assert.deepEqual(app.store.data, {});
});

test("card storage failures return a retryable response without logging selected text", async () => {
  const app = background();
  app.store.storage.local.set = async () => { throw new Error("private text"); };
  const response = await new Promise(resolve => {
    app.message({ type: "SAVE_SELECTION_NOTE", text: "private text" }, cardSender, resolve);
  });
  assert.equal(response.ok, false);
  assert.equal(app.errors.length, 1);
  assert.ok(!JSON.stringify(app.errors).includes("private text"));
});

test("install and updates recreate two menus without duplicates or resetting notes", async () => {
  const stored = note("existing");
  const app = background(undefined, storageMock({ [noteKey(stored.id)]: stored }));
  app.menus.set("save-page-url-note", { contexts: ["page"] });
  for (const reason of ["install", "update", "update"]) {
    await app.install(reason);
    assert.equal(app.menus.size, 2);
    assert.deepEqual([...app.menus.values()].map(menu => Array.from(menu.contexts)), [["selection"], ["selection"]]);
    assert.equal(app.menus.has("save-page-url-note"), false);
    assert.equal(app.menus.get("look-up-property").title, "Look up property");
    assert.deepEqual(Array.from(app.menus.get("look-up-property").documentUrlPatterns), ["http://*/*", "https://*/*"]);
    assert.deepEqual(app.store.data[noteKey(stored.id)], stored);
  }
  assert.equal(app.calls.length, 1);
});

test("menu failures are handled independently of welcome-tab creation", async () => {
  const app = background(undefined, undefined, true);
  await assert.doesNotReject(() => app.install("install"));
  assert.equal(app.calls.length, 1);
  assert.match(app.errors[0][0], /Could not set up/);
});

test("context captures preserve selected text and ignore the removed URL action", async () => {
  const app = background();
  await Promise.all([
    app.click({ menuItemId: "save-selection-note", selectionText: "  <b>selected</b>\ntext  " }),
    app.click({ menuItemId: "save-page-url-note", pageUrl: "https://example.com/page",
      frameUrl: "https://example.com/frame", linkUrl: "https://example.com/link" }),
  ]);
  const notes = Object.values(app.store.data);
  assert.equal(notes.length, 1);
  assert.deepEqual(notes.map(note => [note.type, note.text]), [
    ["selection", "  <b>selected</b>\ntext  "],
  ]);
  for (const note of notes) {
    assert.ok(note.createdAt > 0);
    assert.ok(app.store.data[noteKey(note.id)]);
  }
});

test("missing or blank capture data and unknown menus do not save", async () => {
  const app = background();
  for (const info of [
    { menuItemId: "unknown", selectionText: "text" },
    { menuItemId: "save-selection-note" },
    { menuItemId: "save-selection-note", selectionText: " \n " },
    { menuItemId: "save-page-url-note", frameUrl: "https://example.com/frame" },
    { menuItemId: "save-page-url-note", pageUrl: "" },
  ]) await app.click(info);
  assert.deepEqual(app.store.data, {});
});

test("worker restarts preserve notes and immediately handle new captures", async () => {
  const store = storageMock();
  await background(undefined, store).click({ menuItemId: "save-selection-note", selectionText: "first" });
  await background(undefined, store).click({ menuItemId: "save-selection-note", selectionText: "second" });
  assert.deepEqual(Object.values(store.data).map(note => note.text), ["first", "second"]);
});

const lookupInfo = { menuItemId: "look-up-property", selectionText: "26 Tudor Street, Surry Hills",
  pageUrl: "https://example.com/property", frameId: 0, editable: false };

test("context lookup targets the clicked tab's top frame without creating notes", async () => {
  const app = background();
  await app.click(lookupInfo, { id: 42 });
  assert.equal(app.tabMessages.length, 1);
  const sent = app.tabMessages[0];
  assert.equal(sent.tabId, 42);
  assert.equal(sent.options.frameId, 0);
  assert.equal(sent.message.type, "LOOK_UP_SELECTION");
  assert.equal(sent.message.text, lookupInfo.selectionText);
  assert.deepEqual(app.store.data, {});
});

test("context lookup rejects unsupported pages, frames, fields, tabs and text", async () => {
  const app = background();
  for (const override of [{ frameId: 3 }, { editable: true }, { pageUrl: "chrome://settings" },
    { selectionText: " " }, { selectionText: "a" }, { selectionText: "a".repeat(1001) }, { selectionText: undefined }]) {
    await app.click({ ...lookupInfo, ...override }, { id: 42 });
  }
  for (const tab of [undefined, {}, { id: -1 }]) await app.click(lookupInfo, tab);
  assert.deepEqual(app.tabMessages, []);
  assert.deepEqual(app.store.data, {});
});

test("context lookup handles missing receivers and rejected replies without logging selected text", async () => {
  for (const deliver of [async () => { throw new Error(lookupInfo.selectionText); }, async () => ({ ok: false })]) {
    const app = background();
    app.chrome.tabs.sendMessage = deliver;
    await assert.doesNotReject(() => app.click(lookupInfo, { id: 42 }));
    assert.match(app.errors[0][0], /Reload this webpage/);
    assert.ok(!JSON.stringify(app.errors).includes(lookupInfo.selectionText));
    assert.deepEqual(app.store.data, {});
  }
});

test("storage errors are caught without logging note contents", async () => {
  const app = background();
  app.store.storage.local.set = async () => { throw new Error("private text"); };
  await assert.doesNotReject(() => app.click({ menuItemId: "save-selection-note", selectionText: "private text" }));
  assert.equal(app.errors.length, 1);
  assert.match(app.errors[0][0], /Could not save/);
  assert.ok(!JSON.stringify(app.errors).includes("private text"));
});

test("a fresh install opens one active tab at the bundled welcome URL", async () => {
  const app = background();
  await app.install("install");
  assert.deepEqual(app.paths, ["welcome/welcome.html"]);
  assert.deepEqual(app.calls, [{ url: welcomeURL, active: true }]);
  assert.deepEqual(app.errors, []);
});

test("updates and other install reasons never open the welcome page", async () => {
  const app = background();
  for (const reason of ["update", "chrome_update", "shared_module_update", "unknown", undefined]) {
    await app.install(reason);
  }
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.paths, []);
  assert.deepEqual(app.errors, []);
});

test("a rejected tab creation is logged and handled without retrying", async () => {
  const failure = new Error("Tab creation unavailable");
  const app = background(async () => { throw failure; });
  await assert.doesNotReject(() => app.install("install"));
  assert.equal(app.calls.length, 1);
  assert.equal(app.errors.length, 1);
  assert.match(app.errors[0][0], /Could not open.*welcome page/);
  assert.equal(app.errors[0][1], failure);
});

test("a synchronous tab API failure is also handled without retrying", async () => {
  const failure = new Error("Tab API unavailable");
  const app = background(() => { throw failure; });
  await assert.doesNotReject(() => app.install("install"));
  assert.equal(app.calls.length, 1);
  assert.equal(app.errors.length, 1);
  assert.equal(app.errors[0][1], failure);
});

test("property messages reject invalid senders and malformed payloads without accessing the API", () => {
  const app = background();
  for (const [message, sender] of [
    [{ type: "SEARCH_ADDRESS", address: " " }, cardSender],
    [{ type: "SEARCH_ADDRESS", address: "x".repeat(1001) }, cardSender],
    [{ type: "PROPERTY_DETAILS", id: "../arbitrary/path" }, cardSender],
    [{ type: "PROPERTY_DETAILS", id: "GANSW1" }, { ...cardSender, frameId: 2 }],
    [{ type: "SEARCH_ADDRESS", address: "26 Tudor Street" }, { ...cardSender, id: "another-extension" }],
  ]) {
    let response;
    assert.equal(app.message(message, sender, value => { response = value; }), undefined);
    assert.equal(response.ok, false);
  }
  assert.deepEqual(app.store.data, {});
});

test("real worker property handlers return setup feedback with no configuration or API calls", async () => {
  const app = background();
  for (const message of [{ type: "SEARCH_ADDRESS", address: "26 Tudor Street\nSurry Hills" }, { type: "PROPERTY_DETAILS", id: "GANSW1" }]) {
    const response = await new Promise(resolve => {
      assert.equal(app.message(message, cardSender, resolve), true);
    });
    if (message.type === "SEARCH_ADDRESS") assert.equal(response.error.code, "configuration");
    else for (const section of Object.values(response.sections)) assert.equal(section.error.code, "configuration");
  }
  assert.deepEqual(app.store.data, {});
});

test('additional property section messages validate sender, section, ID and optional market part', async () => {
  const app = background();
  for (const [message, sender] of [
    [{ type: 'PROPERTY_SECTION', id: 'GANSW1', section: 'schools' }, { ...cardSender, id: 'untrusted' }],
    [{ type: 'PROPERTY_SECTION', id: 'GANSW1', section: 'schools' }, { ...cardSender, frameId: 1 }],
    [{ type: 'PROPERTY_SECTION', id: 'GANSW1', section: 'schools' }, { ...cardSender, tab: undefined }],
    [{ type: 'PROPERTY_SECTION', id: '../path', section: 'schools' }, cardSender],
    [{ type: 'PROPERTY_SECTION', id: 'GANSW1', section: 'https://external.example' }, cardSender],
    [{ type: 'PROPERTY_SECTION', id: 'GANSW1', section: '__proto__' }, cardSender],
    [{ type: 'PROPERTY_SECTION', id: 'GANSW1', section: 'schools', part: 'sale' }, cardSender],
    [{ type: 'PROPERTY_SECTION', id: 'GANSW1', section: 'market', part: '../path' }, cardSender],
  ]) {
    let response;
    assert.equal(app.message(message, sender, value => { response = value; }), undefined);
    assert.equal(response.ok, false);
  }
  for (const section of ['market', 'planning', 'schools', 'amenities', 'transport']) {
    const result = await new Promise(resolve => {
      assert.equal(app.message({ type: 'PROPERTY_SECTION', id: 'GANSW1', section }, cardSender, resolve), true);
    });
    for (const part of section === 'market' ? Object.values(result.market) : [result.section]) assert.equal(part.error.code, 'configuration');
  }
  assert.deepEqual(app.store.data, {});
});
