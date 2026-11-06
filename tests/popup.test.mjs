import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { note, noteKey, settle, storageMock } from "./helpers/storage.mjs";

const source = await readFile(new URL("../popup/popup.js", import.meta.url), "utf8");
const consts = await readFile(new URL("../consts.js", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../property-api.js", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../background.js", import.meta.url), "utf8");

class Element {
  constructor(document, tagName = "button") {
    this.document = document;
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.scrollTop = 0;
  }
  addEventListener(type, handler) { this[type] = handler; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelectorAll(tag) {
    return this.children.flatMap(child => [ ...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]);
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  focus() { this.document.activeElement = this; }
  setCustomValidity(value) { this.validationMessage = value; }
  reportValidity() { this.validityReported = true; }
  set innerHTML(_) { throw new Error("Notes must not be rendered as HTML"); }
}

async function popup(overrides = {}, store = storageMock()) {
  const document = { activeElement: null, createElement: tag => new Element(document, tag) };
  const elements = new Map(["status", "open-options", "open-side-panel", "show-widget", "note-form",
    "note-text", "save-note", "notes-list", "notes-empty"].map(id => [id, new Element(document)]));
  elements.get("open-side-panel").disabled = true;
  document.getElementById = id => elements.get(id);
  const calls = [];
  const chrome = {
    storage: store.storage,
    windows: { getCurrent: async () => ({ id: 7 }) },
    runtime: { openOptionsPage: async () => { calls.push("options"); } },
    sidePanel: { open: async options => { calls.push(["panel", options.windowId]); } },
    tabs: {
      query: async () => [{ id: 42 }],
      sendMessage: async (id, message, options) => {
        calls.push(["widget", id, message.type, options.frameId]);
        return { ok: true };
      },
    },
  };
  for (const [name, methods] of Object.entries(overrides)) Object.assign(chrome[name], methods);
  const context = vm.createContext({ document, chrome, crypto: { randomUUID } });
  vm.runInContext(consts, context);
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { elements, calls, chrome, document, store,
    click: id => elements.get(id).click(), status: () => elements.get("status").textContent,
    save: () => elements.get("note-form").submit({ preventDefault() {} }),
    texts: () => elements.get("notes-list").querySelectorAll("p").map(item => item.textContent),
    deletes: () => elements.get("notes-list").querySelectorAll("button"),
  };
}

test("options and widget buttons invoke their APIs and report success", async () => {
  const app = await popup();
  await app.click("open-options");
  assert.equal(app.status(), "Options opened.");
  await app.click("show-widget");
  assert.equal(app.status(), "Page widget shown.");
  assert.deepEqual(app.calls, ["options", ["widget", 42, "SHOW_WIDGET", 0]]);
});

test("side panel API is invoked synchronously within the click handler", async () => {
  const app = await popup();
  assert.equal(app.elements.get("open-side-panel").disabled, false);
  const completed = app.click("open-side-panel");
  // An await before the API call would drop gesture-dependent dispatch here.
  assert.deepEqual(app.calls, [["panel", 7]]);
  await completed;
  assert.equal(app.status(), "Side panel opened.");
});

test("each action catches API rejection and supports retry", async () => {
  const reject = async () => { throw new Error("API unavailable"); };
  const app = await popup({ runtime: { openOptionsPage: reject }, sidePanel: { open: reject }, tabs: { sendMessage: reject } });
  for (const [id, message] of [["open-options", /Could not open options/], ["open-side-panel", /Could not open the side panel/],
    ["show-widget", /Open a regular web page and reload it/]]) {
    await app.click(id);
    assert.match(app.status(), message);
  }
  app.chrome.runtime.openOptionsPage = async () => {};
  await app.click("open-options");
  assert.equal(app.status(), "Options opened.");
});

test("widget requires an active tab and a positive acknowledgement", async () => {
  for (const tabs of [{ query: async () => [] }, { sendMessage: async () => undefined }, { sendMessage: async () => ({ ok: false }) }]) {
    const app = await popup({ tabs });
    await app.click("show-widget");
    assert.match(app.status(), /Could not show the widget/);
  }
});

test("window lookup failure leaves the side panel disabled and other actions usable", async () => {
  const app = await popup({ windows: { getCurrent: async () => { throw new Error("No window"); } } });
  assert.equal(app.elements.get("open-side-panel").disabled, true);
  assert.match(app.status(), /Reopen the popup/);
  await app.click("open-options");
  assert.equal(app.status(), "Options opened.");
});

test("manual saves preserve whitespace, render literal text and persist after reopening", async () => {
  const app = await popup();
  assert.equal(app.elements.get("notes-empty").textContent, "No saved notes yet.");
  const text = "  <script>alert('test')</script>\n第二行  ";
  app.elements.get("note-text").value = text;
  await app.save();
  assert.equal(app.elements.get("note-text").value, "");
  assert.equal(app.status(), "Note saved.");
  assert.deepEqual(app.texts(), [text]);
  const saved = Object.values(app.store.data)[0];
  assert.equal(saved.type, "manual");
  assert.ok(saved.createdAt > 0);
  assert.deepEqual((await popup({}, app.store)).texts(), [text]);
});

test("blank input is rejected and validation clears when the user types", async () => {
  const app = await popup();
  const input = app.elements.get("note-text");
  input.value = " \n ";
  await app.save();
  assert.deepEqual(app.store.data, {});
  assert.match(input.validationMessage, /Enter a note/);
  assert.equal(input.validityReported, true);
  input.input();
  assert.equal(input.validationMessage, "");
});

test("failed saves retain the draft, re-enable Save and allow a retry", async () => {
  const app = await popup();
  const set = app.chrome.storage.local.set;
  app.chrome.storage.local.set = async () => { throw new Error("Quota exceeded"); };
  app.elements.get("note-text").value = "keep me";
  await app.save();
  assert.match(app.status(), /Could not save/);
  assert.equal(app.elements.get("note-text").value, "keep me");
  assert.equal(app.elements.get("save-note").disabled, false);
  app.chrome.storage.local.set = set;
  await app.save();
  assert.deepEqual(app.texts(), ["keep me"]);
});

test("pending saves reject duplicate submissions and preserve a newer draft", async () => {
  const app = await popup();
  let finish;
  const set = app.chrome.storage.local.set;
  app.chrome.storage.local.set = values => new Promise(resolve => { finish = async () => { await set(values); resolve(); }; });
  app.elements.get("note-text").value = "original";
  const saving = app.save();
  assert.equal(app.elements.get("save-note").disabled, true);
  await app.save();
  app.elements.get("note-text").value = "next draft";
  await finish();
  await saving;
  assert.deepEqual(app.texts(), ["original"]);
  assert.equal(app.elements.get("note-text").value, "next draft");
  assert.equal(Object.keys(app.store.data).length, 1);
});

test("notes are newest first, unrelated keys and malformed notes are ignored", async () => {
  const store = storageMock({
    [noteKey("old")]: note("old", "old", 1),
    [noteKey("new")]: note("new", "new", 2),
    settings: { enabled: true },
    [noteKey("bad")]: { id: "bad", text: 123 },
    [noteKey("wrong-id")]: note("different"),
    [noteKey("123")]: note(123),
    [noteKey("null")]: null,
  });
  const app = await popup({}, store);
  assert.deepEqual(app.texts(), ["new", "old"]);
  await app.deletes()[0].click();
  assert.deepEqual(app.texts(), ["old"]);
  assert.equal(store.data.settings.enabled, true);
});

test("deletion moves focus to next, previous, then the editor", async () => {
  const app = await popup({}, storageMock({
    [noteKey("first")]: note("first", "first", 3),
    [noteKey("middle")]: note("middle", "middle", 2),
    [noteKey("last")]: note("last", "last", 1),
  }));
  app.deletes()[1].focus();
  await app.deletes()[1].click();
  assert.equal(app.document.activeElement.dataset.noteId, "last");
  await app.document.activeElement.click();
  assert.equal(app.document.activeElement.dataset.noteId, "first");
  await app.document.activeElement.click();
  assert.equal(app.document.activeElement, app.elements.get("note-text"));
  assert.equal(app.elements.get("notes-list").hidden, true);
  assert.equal(app.elements.get("notes-empty").hidden, false);
});

test("failed deletions retain the note and support retry", async () => {
  const app = await popup({}, storageMock({ [noteKey("keep")]: note("keep") }));
  const remove = app.chrome.storage.local.remove;
  app.chrome.storage.local.remove = async () => { throw new Error("Unavailable"); };
  app.deletes()[0].focus();
  await app.deletes()[0].click();
  assert.deepEqual(app.texts(), ["keep"]);
  assert.equal(app.document.activeElement, app.deletes()[0]);
  assert.equal(app.deletes()[0].attributes.get("aria-disabled"), "false");
  assert.match(app.status(), /Could not delete/);
  app.chrome.storage.local.remove = remove;
  await app.deletes()[0].click();
  assert.deepEqual(app.texts(), []);
});

test("storage changes refresh the list without stealing editor focus or changing a draft", async () => {
  const app = await popup();
  app.elements.get("note-text").value = "draft";
  app.elements.get("note-text").focus();
  await app.chrome.storage.local.set({ [noteKey("captured")]: note("captured", "captured", 1, "selection") });
  await settle();
  assert.deepEqual(app.texts(), ["captured"]);
  assert.equal(app.document.activeElement, app.elements.get("note-text"));
  assert.equal(app.elements.get("note-text").value, "draft");
});

test("a pending deletion cannot be submitted twice and survives a concurrent list refresh", async () => {
  const app = await popup({}, storageMock({ [noteKey("keep")]: note("keep") }));
  let rejectRemoval;
  let calls = 0;
  app.chrome.storage.local.remove = () => {
    calls++;
    return new Promise((_, reject) => { rejectRemoval = reject; });
  };
  const deleting = app.deletes()[0].click();
  await app.chrome.storage.local.set({ [noteKey("new")]: note("new", "new", 2) });
  await settle();
  const pendingButton = app.deletes().find(button => button.dataset.noteId === "keep");
  assert.equal(pendingButton.attributes.get("aria-disabled"), "true");
  await pendingButton.click();
  assert.equal(calls, 1);
  rejectRemoval(new Error("Unavailable"));
  await deleting;
  assert.equal(pendingButton.attributes.get("aria-disabled"), "false");
  assert.deepEqual(app.texts(), ["new", "keep"]);
});

test("unrelated storage keys and non-local changes do not reload notes", async () => {
  const app = await popup();
  let calls = 0;
  app.chrome.storage.local.get = async () => { calls++; return {}; };
  app.store.listeners[0]({ settings: {} }, "local");
  app.store.listeners[0]({ [noteKey("other")]: {} }, "sync");
  await settle();
  assert.equal(calls, 0);
});

test("stale reads cannot replace a newer storage result", async () => {
  const app = await popup();
  let finishOld;
  app.chrome.storage.local.get = () => new Promise(resolve => { finishOld = resolve; });
  app.store.listeners[0]({ [noteKey("old")]: {} }, "local");
  app.chrome.storage.local.get = async () => ({ [noteKey("new")]: note("new") });
  app.store.listeners[0]({ [noteKey("new")]: {} }, "local");
  await settle();
  finishOld({ [noteKey("old")]: note("old") });
  await settle();
  assert.deepEqual(app.texts(), ["new"]);
});

test("initial and subsequent load failures are handled without erasing rendered notes", async () => {
  const reject = async () => { throw new Error("Unavailable"); };
  const failed = await popup({ storage: { local: { get: reject } } });
  assert.match(failed.status(), /Could not load notes/);
  assert.equal(failed.elements.get("notes-empty").textContent, "Saved notes could not be loaded.");
  const app = await popup({}, storageMock({ [noteKey("keep")]: note("keep") }));
  app.chrome.storage.local.get = reject;
  app.store.listeners[0]({ [noteKey("changed")]: {} }, "local");
  await settle();
  assert.deepEqual(app.texts(), ["keep"]);
  assert.match(app.status(), /Could not load notes/);
});

test("context-menu and popup saves coexist, including a capture during deletion", async () => {
  const app = await popup();
  let capture;
  const context = vm.createContext({ crypto: { randomUUID }, console, chrome: {
    storage: app.chrome.storage,
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
    contextMenus: { onClicked: { addListener: listener => { capture = listener; } } },
  } });
  context.importScripts = path => {
    if (path === "consts.js") vm.runInContext(consts, context);
    else if (path === "property-api.js") vm.runInContext(apiSource, context);
    else throw new Error("Missing generated configuration");
  };
  vm.runInContext(workerSource, context);
  app.elements.get("note-text").value = "manual";
  await Promise.all([app.save(), capture({ menuItemId: "save-selection-note", selectionText: "selected" })]);
  assert.deepEqual(new Set(app.texts()), new Set(["manual", "selected"]));
  const deletedId = app.deletes()[0].dataset.noteId;
  await Promise.all([app.deletes()[0].click(), capture({ menuItemId: "save-selection-note", selectionText: "another selection" })]);
  await settle();
  assert.equal(Object.keys(app.store.data).length, 2);
  assert.equal(app.store.data[noteKey(deletedId)], undefined);
  assert.ok(app.texts().includes("another selection"));
});

test("previously saved URL notes remain readable and deletable", async () => {
  const stored = note("old-url", "https://example.com", 1, "url");
  const app = await popup({}, storageMock({ [noteKey(stored.id)]: stored }));
  assert.deepEqual(app.texts(), [stored.text]);
  await app.deletes()[0].click();
  assert.deepEqual(app.texts(), []);
  assert.equal(app.store.data[noteKey(stored.id)], undefined);
});
