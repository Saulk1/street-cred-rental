import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
const source = await readFile(new URL("../property-api.js", import.meta.url), "utf8");
const config = { baseUrl: "https://api.example.test", apiKey: "test-only-key" };
const reply = (data, status = 200, headers = {}) => ({ ok: status === 200, status,
  headers: { get: name => headers[name] ?? null }, json: async () => ({ data }) });
function client(handler, configured = config) {
  let now = 100000;
  const calls = [];
  const timeouts = new Map();
  let timer = 0;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ MICROBURBS_CONFIG: configured, Date: Clock, URLSearchParams,
    AbortController,
    setTimeout(fn, delay) {
      const id = ++timer;
      if (delay === 20000) timeouts.set(id, fn);
      else { now += delay; queueMicrotask(fn); }
      return id;
    }, clearTimeout(id) { timeouts.delete(id); },
    async fetch(url, options) { calls.push({ url, options, at: now }); return handler(url, options); },
  });
  vm.runInContext(source, context);
  return { api: vm.runInContext("PROPERTY_API", context), calls,
    advance: ms => { now += ms; }, expire: () => { for (const fn of timeouts.values()) fn(); } };
}

test("missing key returns setup guidance without a request", async () => {
  const app = client(() => { throw new Error("Must not call"); }, { ...config, apiKey: "" });
  const result = await app.api.search("26 Tudor St Surry Hills");
  assert.equal(result.error.code, "configuration");
  assert.match(result.error.message, /\.env.local/);
  assert.equal(app.calls.length, 0);
});

test("geocoding encodes unit addresses and normalises open candidate shapes", async () => {
  const app = client(() => reply([
    { id: "GANSW1", display_name: "Unit 2/26 Tudor St", property_type: "unit" },
    { id: "GANSW2", name: "Other address" }, { id: "GANSW3", abbr: "ABBR" },
    { id: "../path", name: "Invalid id" }, { id: "GANSW4" }, null,
  ]));
  const result = await app.api.search("Unit 2/26 Tudor St & Surry Hills");
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.candidates, row => row.label), ["Unit 2/26 Tudor St", "Other address", "ABBR"]);
  assert.equal(new URL(app.calls[0].url).searchParams.get("address"), "Unit 2/26 Tudor St & Surry Hills");
  assert.equal(app.calls[0].options.headers.Authorization, "Bearer test-only-key");
  assert.equal(app.calls[0].options.credentials, "omit");
  assert.equal(app.calls[0].options.redirect, "error");
});

test("null or empty geocoding data returns no matches; malformed responses are errors", async () => {
  for (const data of [null, []]) assert.equal((await client(() => reply(data)).api.search("address")).candidates.length, 0);
  assert.equal((await client(() => reply({ not: "a list" })).api.search("address")).error.code, "response");
  const malformed = client(() => ({ ...reply(null), json: async () => ({ available: true }) }));
  assert.equal((await malformed.api.search("address")).error.code, "response");
});

test("property bundles preserve zero, missing data and risk containment; requests are coalesced", async () => {
  const app = client(url => {
    if (url.endsWith("/basics/all")) return reply({ bed_count: 0, bath_count: null, parking_count: 2, land_area_sqm: 200 });
    if (url.endsWith("/valuation/avm")) return reply(null);
    return reply({ flood: [{ on_property: false, nearest_distance_m: 257, value: "nearby" }],
      bushfire: [{ on_property: true, nearest_distance_m: 0 }], public_housing: null, heritage: [],
      hv_power_line: [{ on_property: false, nearest_distance_m: 55 }] });
  });
  const [result] = await Promise.all([app.api.details("GANSW1"), app.api.details("GANSW1")]);
  assert.equal(app.calls.length, 3);
  assert.ok(app.calls.every(call => !call.url.includes("geojson")));
  assert.equal(result.sections.basics.data.bed_count, 0);
  assert.equal(result.sections.basics.data.bath_count, null);
  assert.equal(result.sections.valuation.status, "empty");
  assert.equal(result.sections.risks.data.flood[0].on_property, false);
  assert.equal(result.sections.risks.data.bushfire[0].nearest_distance_m, 0);
  assert.equal(result.sections.risks.data.heritage.length, 0);
  assert.equal(result.sections.risks.data.public_housing, null);
  for (let index = 1; index < app.calls.length; index++) assert.ok(app.calls[index].at - app.calls[index - 1].at >= 125);
});

test("a failed valuation does not discard successful facts or risk sections", async () => {
  const app = client(url => url.endsWith("/valuation/avm") ? reply(null, 503) : reply({}));
  const result = await app.api.details("GANSW1");
  assert.equal(result.sections.basics.status, "ok");
  assert.equal(result.sections.valuation.error.code, "server");
  assert.equal(result.sections.risks.status, "ok");
});

test("authentication, coverage, validation and server errors are specific and preserve request IDs", async () => {
  for (const [status, code] of [[401, "authentication"], [403, "coverage"], [422, "validation"], [503, "server"]]) {
    const app = client(() => reply(null, status, { "X-Request-Id": "support-id" }));
    const result = await app.api.search("address");
    assert.equal(result.error.code, code);
    assert.equal(result.error.requestId, "support-id");
    assert.ok(!JSON.stringify(result).includes(config.apiKey));
  }
});

test("rate limiting respects Retry-After across different requests and allows a later retry", async () => {
  let status = 429;
  const app = client(() => reply([], status, { "Retry-After": "2" }));
  const result = await app.api.search("first address");
  assert.equal(result.error.retryAt, 102000);
  assert.equal((await app.api.search("second address")).error.code, "rate_limit");
  assert.equal(app.calls.length, 1);
  app.advance(2001); status = 200;
  assert.equal((await app.api.search("second address")).ok, true);
  assert.equal(app.calls.length, 2);
});

test("HTTP-date Retry-After is honoured", async () => {
  const app = client(() => reply([], 429, { "Retry-After": new Date(105000).toUTCString() }));
  assert.equal((await app.api.search("address")).error.retryAt, 105000);
});

test("network failures, invalid JSON and timeouts have safe retryable messages", async () => {
  const network = client(() => { throw new Error("secret URL and credentials"); });
  const result = await network.api.search("address");
  assert.equal(result.error.code, "network");
  assert.ok(!JSON.stringify(result).includes("secret"));
  const json = client(() => ({ ...reply(null), json: async () => { throw new SyntaxError("bad JSON"); } }));
  // Use the VM realm's syntax error to mimic response.json() in the worker.
  assert.ok((await json.api.search("address")).error);
  const app = client((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  const pending = app.api.search("address");
  await new Promise(resolve => setImmediate(resolve));
  app.expire();
  assert.equal((await pending).error.code, "timeout");
});
