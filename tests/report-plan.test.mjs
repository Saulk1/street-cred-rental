import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const context = vm.createContext({ URLSearchParams });
for (const name of ['report-endpoints.js', 'report-plan.js']) vm.runInContext(await readFile(new URL('../extension/' + name, import.meta.url), 'utf8'), context);
const { REPORT_ENDPOINTS: endpoints, REPORT_PLAN: plan } = context;
const profile = { suburb: 'Surry Hills', mesh_block: '11201234567', lga: 'Sydney', sa4: 'Sydney - City',
  sa1: '112345', sa2: 'Surry Hills', sa3: 'City', postcode: '2010', gccsa: 'Greater Sydney', state: 'NSW' };
const plain = value => JSON.parse(JSON.stringify(value));

test('registry accounts for every checked-in API path and every address dataset', async () => {
  const spec = await readFile(new URL('../docs/api/microburbs-hackathon-api.yaml', import.meta.url), 'utf8');
  const paths = [...spec.matchAll(/^  (\/[^\n]+):\s*$/gm)].map(match => match[1]);
  assert.deepEqual(Array.from(endpoints, e => e.path).sort(), paths.sort());
  const tasks = [...plan.start({ id: 'GANSW1' }), ...plan.geographic(profile)];
  const covered = new Set([...tasks.map(t => t.endpoint), ...plan.supporting.map(t => t.endpoint)]);
  assert.equal(covered.size, endpoints.length);
  assert.equal(plan.start({ id: 'GANSW1' }).length, 51);
  assert.equal(tasks.filter(t => t.status === 'skipped').length, 1); // statistics expand after catalog discovery
});

test('geographic paths are encoded, all hazard layers and geometry/counts are included', () => {
  const tasks = plan.geographic({ ...profile, suburb: 'A/B & C' });
  const hazards = tasks.filter(t => t.endpoint.endsWith('/shapes/hazards'));
  assert.equal(hazards.length, 6);
  assert.equal(new Set(hazards.map(t => t.id)).size, 6);
  assert.ok(hazards.every(t => t.path.startsWith('/v1/suburbs/A%2FB%20%26%20C/') && t.path.includes('geojson=true')));
  assert.ok(tasks.find(t => t.endpoint.endsWith('/shapes/mesh-blocks')).path.includes('counts=true'));
  assert.ok(plan.start({ id: 'GANSW1' }).find(t => t.endpoint.endsWith('/risks/flood')).path.includes('geojson=true'));
});

test('missing identifiers are skipped visibly without guessed requests', () => {
  const tasks = plan.geographic(null);
  assert.equal(tasks.filter(t => t.status === 'pending').length, 1); // field catalog only
  assert.ok(tasks.filter(t => t.status === 'skipped').every(t => t.reason.includes('Missing identifier')));
});

test('statistics expand every returned field in batches of at most five for known regions', () => {
  const fields = { fields: Array.from({ length: 12 }, (_, i) => ({ field_code: 'Field_' + i })) };
  const tasks = plan.statistics(profile, fields);
  assert.equal(tasks.length, 27);
  for (const task of tasks) {
    const params = new URLSearchParams(task.path.split('?')[1]);
    assert.ok(params.get('fields').split(',').length <= 5);
    assert.equal(task.status, 'pending');
  }
  assert.equal(plan.statistics({}, fields).length, 0);
});

test('pagination follows totals and next offsets, and stops at the end', () => {
  const task = plan.geographic(profile).find(t => t.endpoint.endsWith('/properties'));
  const next = plan.nextPage(task, { data: { meta: { returned: 200, total: 450 }, results: Array(200).fill({}) } });
  assert.equal(next.query.offset, '200');
  const final = plan.nextPage(next, { data: { meta: { returned: 200, total: 450 }, results: Array(200).fill({}) } });
  assert.equal(final.query.offset, '400');
  assert.equal(plan.nextPage(final, { data: { meta: { returned: 50, total: 450 }, results: Array(50).fill({}) } }), undefined);
  assert.equal(plan.nextPage(task, { data: { meta: { returned: 20, next_offset: 20 }, results: Array(20).fill({}) } }).query.offset, '20');
  assert.equal(plan.nextPage(task, { data: { meta: { returned: 0, next_offset: 0 }, results: [] } }), undefined);
  assert.deepEqual(plain(next.identifiers), plain(task.identifiers));
});
