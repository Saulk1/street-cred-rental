import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
const source = await readFile(new URL("../property-api.js", import.meta.url), "utf8");
const config = { baseUrl: "https://api.example.test", apiKey: "test-only-key" };
const manifest = { host_permissions: [config.baseUrl + "/*"],
  content_security_policy: { extension_pages: "default-src 'none'; connect-src " + config.baseUrl } };
const reply = (data, status = 200, headers = {}) => ({ ok: status === 200, status,
  headers: { get: name => headers[name] ?? null }, json: async () => ({ data }) });
function client(handler, configured = config, installedManifest = manifest, loadFailed = false) {
  let now = 100000;
  const calls = [];
  const timeouts = new Map();
  let timer = 0;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ MICROBURBS_CONFIG: configured, MICROBURBS_CONFIG_LOAD_FAILED: loadFailed,
    chrome: { runtime: { getManifest: () => installedManifest } }, Date: Clock, URL, URLSearchParams,
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

test("configuration failures identify loading, invalid values and policy mismatches before fetching", async () => {
  const cases = [
    [config, manifest, true, /Could not load runtime-config/],
    [{ ...config, baseUrl: "http://api.example.test" }, manifest, false, /Invalid property API settings/],
    [{ ...config, baseUrl: "https://api.example.test/path" }, manifest, false, /Invalid property API settings/],
    [{ ...config, apiKey: " test-only-key" }, manifest, false, /Invalid property API settings/],
    [{ ...config, apiKey: "test-only-key\n" }, manifest, false, /Invalid property API settings/],
    [{ ...config, baseUrl: "https://other.example.test" }, manifest, false, /host permissions/],
    [config, { ...manifest, host_permissions: [] }, false, /host permissions/],
    [config, { ...manifest, content_security_policy: { extension_pages: "connect-src 'none'" } }, false, /connect-src/],
    [config, { ...manifest, content_security_policy: {} }, false, /connect-src/],
    [config, { ...manifest, content_security_policy: {
      extension_pages: "connect-src https://api.example.test; connect-src 'none'" } }, false, /connect-src/],
  ];
  for (const [settings, policy, failed, message] of cases) {
    const app = client(() => { throw new Error("Must not fetch"); }, settings, policy, failed);
    const result = await app.api.search("address");
    assert.equal(result.error.code, "configuration");
    assert.match(result.error.message, message);
    assert.ok(!JSON.stringify(result).includes(config.apiKey));
    assert.equal(app.calls.length, 0);
  }
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

// Field shapes derived from assets/microburbs-hackathon-api.yaml; all values
// below are invented fixture data and never use the team's API credentials.
const extraFixture = JSON.parse(await readFile(new URL('./fixtures/property-sections.json', import.meta.url), 'utf8'));
test('extra sections use fixed YAML endpoint paths and normalize only display fields', async () => {
  const app = client(url => {
    const path = new URL(url).pathname;
    const key = path.endsWith('sale-history-latest') ? 'sale' : path.endsWith('rent-history-latest') ? 'rent'
      : path.includes('development') ? 'planning' : path.includes('schools') ? 'schools' : path.includes('amenities') ? 'amenities' : 'transport';
    return reply(extraFixture[key]);
  });
  const market = await app.api.extra('GANSW1', 'market');
  assert.equal(market.market.sale.data.type, 'For Sale');
  assert.equal(market.market.rent.data.price, 3000);
  const expected = { planning: '/development/all', schools: '/schools/nearby', amenities: '/amenities/nearby?radius_m=1000', transport: '/transport/nearby?radius_m=1000' };
  for (const [key, path] of Object.entries(expected)) {
    const result = await app.api.extra('GANSW1', key);
    assert.equal(result.section.status, 'ok');
    assert.ok(app.calls.at(-1).url.endsWith(path));
    assert.ok(!JSON.stringify(result).includes('center_lat'));
  }
  assert.equal(app.calls.length, 6);
  const planning = await app.api.extra('GANSW1', 'planning');
  assert.deepEqual(Array.from(planning.section.data.zoning_overlays, r => r.value), ['10 m', '5.5 m', '1.5', 'Original unit']);
});
test('invalid section, ID and market part cannot become arbitrary API paths', async () => {
  const app = client(() => { throw new Error('No request expected'); });
  for (const args of [['../id', 'schools'], ['GANSW1', '../profile'], ['GANSW1', '__proto__'], ['GANSW1', 'market', 'https://external.example'], ['GANSW1', 'schools', 'sale']]) {
    assert.equal((await app.api.extra(...args)).error.code, 'validation');
  }
  assert.equal(app.calls.length, 0);
});
test('market failures preserve the other observation and targeted retry requests only the failed part', async () => {
  const app = client(url => url.endsWith('/rent-history-latest') ? reply(null, 503) : reply(extraFixture.sale));
  const result = await app.api.extra('GANSW1', 'market');
  assert.equal(result.market.sale.status, 'ok'); assert.equal(result.market.rent.status, 'error');
  await app.api.extra('GANSW1', 'market', 'rent');
  assert.equal(app.calls.length, 3); assert.ok(app.calls.at(-1).url.endsWith('/rent-history-latest'));
});
test('extra sections preserve zero counts, nullable fields and distinguish empty from malformed data', async () => {
  assert.equal((await client(() => reply(null)).api.extra('GANSW1', 'planning')).section.status, 'empty');
  assert.equal((await client(() => reply([])).api.extra('GANSW1', 'schools')).section.data.length, 0);
  for (const key of ['planning', 'schools', 'amenities', 'transport']) {
    assert.equal((await client(() => reply('not a valid payload')).api.extra('GANSW1', key)).section.error.code, 'response');
  }
  const transport = await client(() => reply(extraFixture.transport)).api.extra('GANSW1', 'transport');
  assert.equal(transport.section.data.counts.ferry, 0); assert.equal(transport.section.data.nearest.ferry, null);
  assert.equal(transport.section.data.nearest.bus.name, null);
  const schools = await client(() => reply([{ name: 'Far', distance_m: 900 }, null, { name: 'At address', distance_m: 0 }, { name: 'Unknown', distance_m: -1 }])).api.extra('GANSW1', 'schools');
  assert.deepEqual(Array.from(schools.section.data, r => r.distance_m), [0, 900, null]);
});
test('additional section requests share throttling, Retry-After and in-flight coalescing', async () => {
  const app = client(() => reply(extraFixture.schools));
  await Promise.all([app.api.extra('GANSW1', 'schools'), app.api.extra('GANSW1', 'schools')]);
  assert.equal(app.calls.length, 1);
  let limited = true;
  const rate = client(() => limited ? reply(null, 429, { 'Retry-After': '2' }) : reply(extraFixture.transport));
  const result = await rate.api.extra('GANSW1', 'schools');
  assert.equal(result.section.error.code, 'rate_limit');
  assert.equal((await rate.api.extra('GANSW1', 'transport')).section.error.code, 'rate_limit');
  assert.equal(rate.calls.length, 1);
  rate.advance(2001); limited = false;
  assert.equal((await rate.api.extra('GANSW1', 'transport')).section.status, 'ok');
});
