import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const sources = Object.fromEntries(await Promise.all(['report-endpoints.js', 'report-plan.js', 'report-worker.js'].map(async name => [name, await readFile(new URL('../' + name, import.meta.url), 'utf8')])));
const profile = { suburb: 'Surry Hills', mesh_block: '11201234567' };
const selected = id => ({ id, label: id + ' example address' });
const failure = (code, extra = {}) => Object.assign(new Error(code), { detail: { code, message: 'Safe ' + code, ...extra } });
function persistence() {
  let job;
  const cache = new Map(), local = {};
  return { cache, local,
    store: {
      job: async () => structuredClone(job), save: async value => { job = structuredClone(value); },
      result: async key => structuredClone(cache.get(key)),
      put: async value => { cache.set(value.key, structuredClone(value)); }, prune: async () => {},
    },
  };
}
function worker({ saved = persistence(), handler, step = 0 } = {}) {
  let now = 1_000_000, origin = 'https://api.example.test', concurrent = 0, maximum = 0;
  const calls = [], alarms = [];
  const clock = class extends Date { static now() { return now; } };
  const context = vm.createContext({ URLSearchParams, crypto: { randomUUID }, Date: clock,
    chrome: { storage: { local: { get: async () => structuredClone(saved.local), set: async value => Object.assign(saved.local, structuredClone(value)) } },
      alarms: { create: (name, options) => { alarms.push({ name, options }); }, clear: async () => true, onAlarm: { addListener() {} } } },
    REPORT_STORE: saved.store,
    PROPERTY_API: { origin: () => origin, async raw(path) {
      calls.push(path); now += step; maximum = Math.max(maximum, ++concurrent);
      try {
        if (handler) return await handler(path);
        return { data: path.includes('/properties/') && path.endsWith('/profile') ? profile
          : path === '/v1/area-stats/fields?limit=500' ? { fields: [{ field_code: 'Median_age_persons' }] } : { value: 0 }, available: true };
      } finally { concurrent--; }
    } },
  });
  vm.runInContext(sources['report-endpoints.js'], context);
  // Keep the real dependency planner but a small representative set per scenario.
  context.REPORT_ENDPOINTS = context.REPORT_ENDPOINTS.filter(e => [
    '/v1/properties/{gnaf_id}/profile', '/v1/properties/{gnaf_id}/valuation/avm', '/v1/properties/{gnaf_id}/basics/all',
    '/v1/suburbs/{suburb_name}/profile', '/v1/mbs/{mb_code}/profile', '/v1/area-stats/fields', '/v1/area-stats/{region_level}/{region}/values',
  ].includes(e.path));
  vm.runInContext(sources['report-plan.js'], context);
  vm.runInContext(sources['report-worker.js'], context);
  return { api: context.PROPERTY_REPORT, saved, calls, alarms, advance: value => { now += value; }, origin: value => { origin = value; }, maximum: () => maximum };
}

test('full responses persist, dependency discovery completes and repeated selection uses cached data', async () => {
  const app = worker();
  await app.api.confirm(selected('GANSW1')); await app.api.pump();
  const { report } = await app.api.read();
  assert.equal(report.state, 'complete'); assert.equal(report.errors, 0);
  assert.equal(report.total, report.completed);
  assert.ok(app.calls.some(path => path.includes('/suburbs/Surry%20Hills/profile')));
  assert.ok(app.calls.some(path => path.includes('/area-stats/SAL/')));
  assert.ok(app.maximum() <= 2);
  const task = report.tasks.find(t => t.endpoint.endsWith('/basics/all'));
  assert.equal((await app.api.result(report.id, task.id)).result.data.value, 0);
  const count = app.calls.length;
  await app.api.confirm(selected('GANSW1')); await app.api.pump();
  assert.equal(app.calls.length, count);
  assert.equal((await app.api.result('other-generation', task.id)).ok, false);
});

test('refresh ignores the cache, and an individual retry only fetches its endpoint', async () => {
  let unavailable = true;
  const app = worker({ handler: async path => ({ data: path.endsWith('/profile') ? profile : null, available: path.includes('/basics/all') ? !unavailable : false }) });
  await app.api.confirm(selected('GANSW1')); await app.api.pump();
  let { report } = await app.api.read();
  const task = report.tasks.find(t => t.endpoint.endsWith('/basics/all'));
  unavailable = false;
  const count = app.calls.length;
  await app.api.retry(report.id, task.id); await app.api.pump();
  assert.equal(app.calls.length, count + 1);
  await app.api.confirm(selected('GANSW1'), true); await app.api.pump();
  assert.ok(app.calls.length > count + 1);
  assert.notEqual((await app.api.read()).report.id, report.id);
});

test('authentication pauses the queue and keeps successful results', async () => {
  const app = worker({ handler: async path => {
    if (path.endsWith('/valuation/avm')) throw failure('authentication');
    return { data: profile };
  } });
  await app.api.confirm(selected('GANSW1')); await app.api.pump();
  const { report } = await app.api.read();
  assert.equal(report.state, 'paused'); assert.match(report.error, /authentication/);
  assert.equal(report.tasks.find(t => t.endpoint.endsWith('/profile')).status, 'ok');
  assert.ok(report.tasks.some(t => t.status === 'pending'));
});

test('rate-limited work resumes after retryAt without retrying successful responses', async () => {
  let limited = true;
  const app = worker({ handler: async path => {
    if (path.endsWith('/valuation/avm') && limited) throw failure('rate_limit', { retryAt: 1_002_000 });
    return { data: path.endsWith('/profile') ? profile : null };
  } });
  await app.api.confirm(selected('GANSW1')); await app.api.pump();
  assert.equal((await app.api.read()).report.state, 'running');
  const profiles = app.calls.filter(path => path.includes('/properties/') && path.endsWith('/profile')).length;
  limited = false; app.advance(2001); await app.api.pump();
  assert.equal((await app.api.read()).report.state, 'complete');
  assert.equal(app.calls.filter(path => path.includes('/properties/') && path.endsWith('/profile')).length, profiles);
  assert.ok(app.alarms.some(a => a.options.delayInMinutes === 1));
});

test('bounded work survives a new worker and restores the durable pending queue', async () => {
  const saved = persistence();
  const first = worker({ saved, step: 11_000 });
  await first.api.confirm(selected('GANSW1')); await first.api.pump();
  assert.equal((await first.api.read()).report.state, 'running');
  const second = worker({ saved });
  await second.api.pump();
  assert.equal((await second.api.read()).report.state, 'complete');
  assert.ok(!second.calls.some(path => path.includes('/properties/') && path.endsWith('/profile')));
});

test('a newer address wins even when the previous profile resolves later', async () => {
  let release;
  const app = worker({ handler: path => path.includes('GANSW1/profile') ? new Promise(resolve => { release = () => resolve({ data: profile }); }) : Promise.resolve({ data: null }) });
  await app.api.confirm(selected('GANSW1'));
  await new Promise(resolve => setImmediate(resolve));
  await app.api.confirm(selected('GANSW2'));
  release(); await app.api.pump(); await app.api.pump();
  const { report } = await app.api.read();
  assert.equal(report.candidate.id, 'GANSW2');
  assert.ok(!report.tasks.some(t => t.id.includes('GANSW1')));
});

test('a configuration change pauses pending work without contacting the wrong origin', async () => {
  const app = worker({ step: 11_000 });
  await app.api.confirm(selected('GANSW1')); await app.api.pump();
  const count = app.calls.length;
  app.origin('https://different.example.test'); await app.api.pump();
  assert.equal(app.calls.length, count);
  assert.equal((await app.api.read()).report.state, 'paused');
});

test('storage failures are reported without losing unrelated successful data', async () => {
  const saved = persistence();
  const put = saved.store.put;
  saved.store.put = value => value.key.includes('basics/all') ? Promise.reject(new Error('private detail')) : put(value);
  const app = worker({ saved });
  await app.api.confirm(selected('GANSW1')); await app.api.pump();
  const { report } = await app.api.read();
  assert.equal(report.errors, 1);
  assert.ok(!JSON.stringify(report).includes('private detail'));
  assert.ok(report.tasks.some(t => t.status === 'ok'));
});
