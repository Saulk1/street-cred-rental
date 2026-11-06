import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
const welcomeURL = "chrome-extension://test-extension/welcome/welcome.html";

function background(createTab = async () => ({ id: 1 })) {
  const listeners = [];
  const calls = [];
  const paths = [];
  const errors = [];
  const chrome = {
    runtime: {
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
  vm.runInNewContext(source, { chrome, console: { error: (...args) => errors.push(args) } });
  return { listeners, calls, paths, errors, install: reason => listeners[0]({ reason }) };
}

test("worker startup registers the install listener without opening a tab", () => {
  const app = background();
  assert.equal(app.listeners.length, 1);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.paths, []);
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
