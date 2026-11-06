import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { note, noteKey, storageMock } from "./helpers/storage.mjs";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
const consts = await readFile(new URL("../consts.js", import.meta.url), "utf8");
const welcomeURL = "chrome-extension://test-extension/welcome/welcome.html";

function background(createTab = async () => ({ id: 1 }), store = storageMock(), menuFailure) {
  const listeners = [];
  const calls = [];
  const paths = [];
  const errors = [];
  const menus = new Map();
  const clickListeners = [];
  const messageListeners = [];
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
      create({ url, active }) {
        calls.push({ url, active });
        return createTab();
      },
    },
  };
  const context = vm.createContext({ chrome, crypto: { randomUUID }, console: { error: (...args) => errors.push(args) } });
  context.importScripts = path => {
    assert.equal(path, "consts.js");
    vm.runInContext(consts, context);
  };
  vm.runInContext(source, context);
  return { listeners, calls, paths, errors, menus, clickListeners, store,
    message: (message, sender, respond) => messageListeners[0](message, sender, respond),
    click: info => clickListeners[0](info),
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
  for (const reason of ["install", "update", "update"]) {
    await app.install(reason);
    assert.equal(app.menus.size, 2);
    assert.deepEqual([...app.menus.values()].map(menu => Array.from(menu.contexts)), [["selection"], ["page"]]);
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

test("context captures preserve text and use the page URL rather than frame or link URL", async () => {
  const app = background();
  await Promise.all([
    app.click({ menuItemId: "save-selection-note", selectionText: "  <b>selected</b>\ntext  " }),
    app.click({ menuItemId: "save-page-url-note", pageUrl: "https://example.com/page",
      frameUrl: "https://example.com/frame", linkUrl: "https://example.com/link" }),
  ]);
  const notes = Object.values(app.store.data);
  assert.equal(notes.length, 2);
  assert.notEqual(notes[0].id, notes[1].id);
  assert.deepEqual(notes.map(note => [note.type, note.text]), [
    ["selection", "  <b>selected</b>\ntext  "], ["url", "https://example.com/page"],
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
