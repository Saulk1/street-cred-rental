import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../popup/popup.js", import.meta.url), "utf8");

async function popup(overrides = {}) {
  const elements = new Map(["status", "open-options", "open-side-panel", "show-widget"].map(id =>
    [id, { textContent: "", disabled: id === "open-side-panel", addEventListener(type, handler) { this[type] = handler; } }]));
  const calls = [];
  const chrome = {
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
  vm.runInNewContext(source, { document: { getElementById: id => elements.get(id) }, chrome });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, calls, chrome, click: id => elements.get(id).click(), status: () => elements.get("status").textContent };
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
