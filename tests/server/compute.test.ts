import { execFileSync } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { computationClient, computationTools, computeSettings } from '../../server/compute';
import { propertyClient } from '../../server/property';
import type { Calculation } from '../../shared/compute';

const token = 'dummy-compute-token-32-characters-long';
const messages = [{ role: 'user' as const, content: 'Compare $750 per week for 26 Tudor Street. The historical listing was weekly.' }];
const period = { value: 'week', quote: 'The historical listing was weekly.', message_index: 0 };
const args = { id: 'GANSW1', inputs: { weekly_rent_aud: { value: 750, quote: '$750 per week', message_index: 0 }, reference_period: period } };
const dataset = { status: 'ok', source: { id: 'S2', label: 'Latest rent', path: '/v1/properties/GANSW1/rent-history-latest' },
  retrievedAt: '2026-11-07T00:00:00.000Z', data: { price: 720, type: 'For Rent', date: '2025-07-24', address: '26 Tudor Street' } };

function python(body: string) {
  return JSON.parse(execFileSync('python3', ['-c',
    'import json,sys; from api.compute import process; status,body=process("POST", "Bearer " + __import__("os").environ["COMPUTE_SERVICE_TOKEN"], "application/json", sys.stdin.buffer.read()); print(json.dumps({"status":status,"body":body}))'],
  { input: body, cwd: process.cwd(), env: { ...process.env, COMPUTE_SERVICE_TOKEN: token } }).toString());
}
beforeEach(() => {
  vi.stubEnv('COMPUTE_API_URL', 'https://compute.example.test/api/compute');
  vi.stubEnv('COMPUTE_SERVICE_TOKEN', token);
});
const client = (execute = vi.fn(async () => structuredClone(dataset)), emit = vi.fn()) => ({
  execute, emit, compute: computationClient(execute, messages, new AbortController().signal, emit, Date.now() + 55000),
});

it('runs real Python with trusted API data and emits a reproducible result', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const result = python(init!.body as string);
    return Response.json(result.body, { status: result.status });
  });
  const { compute, execute, emit } = client();
  const result = await compute('compute_rent_comparison', args) as { calculation: Calculation };
  expect(execute).toHaveBeenCalledWith('property_section', { id: 'GANSW1', section: 'market', part: 'rent' });
  expect(result.calculation.metrics.map(m => m.value)).toEqual([720, 30, 1560, 4.17]);
  expect(result.calculation).toMatchObject({ id: 'C1', version: '1.0.0', userInputs: [{ value: 750, quote: '$750 per week' }, { value: 'week' }], apiInputs: [{ sourceId: 'S2', data: dataset.data }] });
  expect(emit).toHaveBeenCalledWith(result.calculation);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit', headers: { Authorization: `Bearer ${token}` } });
  expect(computationTools[0]).toMatchObject({ type: 'function', name: 'compute_rent_comparison', strict: true });
});

it('asks for missing inputs without fetching data or contacting Python', async () => {
  const { compute, execute, emit } = client(); const fetcher = vi.spyOn(globalThis, 'fetch');
  expect(await compute('compute_rent_comparison', { id: 'GANSW1', inputs: { weekly_rent_aud: { value: null, quote: null, message_index: null }, reference_period: period } })).toMatchObject({ status: 'needs_input' });
  expect(execute).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
});

it.each([
  { value: 900, quote: '$750 per week', message_index: 0 },
  { value: 750, quote: 'invented 750', message_index: 0 },
  { value: 750, quote: '$750 per week', message_index: 1 },
  { value: -1, quote: '-1', message_index: 0 },
])('rejects unsupported user values and provenance before fetching', async supplied => {
  const { compute, execute } = client();
  await expect(compute('compute_rent_comparison', { id: 'GANSW1', inputs: { weekly_rent_aud: supplied, reference_period: period } })).rejects.toMatchObject({ code: 'validation' });
  expect(execute).not.toHaveBeenCalled();
});

it('does not use an assistant message as user evidence or accept arbitrary calculator/data fields', async () => {
  const execute = vi.fn();
  const compute = computationClient(execute, [{ role: 'assistant', content: '$750 per week' }], new AbortController().signal, vi.fn(), Date.now() + 55000);
  await expect(compute('compute_rent_comparison', args)).rejects.toMatchObject({ code: 'validation' });
  await expect(compute('compute_../../os', args)).rejects.toMatchObject({ code: 'validation' });
  await expect(compute('compute_rent_comparison', { ...args, datasets: { price: 1 } })).rejects.toMatchObject({ code: 'validation' });
});

it('uses the existing search guard and deduplicates API data within a turn', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).includes('compute.example')) { const p = python(init!.body as string); return Response.json(p.body, { status: p.status }); }
    return Response.json({ data: String(url).includes('geocode') ? [{ id: 'GANSW1' }] : dataset.data });
  });
  const execute = propertyClient({ baseUrl: 'https://property.example.test', apiKey: 'dummy-key' }, new AbortController().signal, vi.fn());
  const compute = computationClient(execute, messages, new AbortController().signal, vi.fn(), Date.now() + 55000);
  await expect(compute('compute_rent_comparison', args)).rejects.toMatchObject({ code: 'validation' });
  await execute('search_address', { address: '26 Tudor Street' });
  await execute('property_section', { id: 'GANSW1', section: 'market', part: 'rent' });
  await compute('compute_rent_comparison', args);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('rent-history'))).toHaveLength(1);
});

it('keeps unavailable API data distinct from a computed zero', async () => {
  const { compute, emit } = client(vi.fn(async () => ({ ...dataset, status: 'empty' })));
  expect(await compute('compute_rent_comparison', args)).toMatchObject({ status: 'unavailable' });
  expect(emit).not.toHaveBeenCalled();
});

it('rejects wrong versions, invalid units and nonfinite computation outputs', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const output = python(JSON.stringify({ calculator: 'rent_comparison', version: '1.0.0', inputs: { weekly_rent_aud: 750, reference_period: 'week' }, datasets: { latest_rent: dataset.data }, deadlineMs: Date.now() + 8000 })).body;
  for (const result of [{ ...output, version: '9' }, { ...output, metrics: [{ ...output.metrics[0], unit: 'USD' }, ...output.metrics.slice(1)] }, { ...output, metrics: [{ ...output.metrics[0], value: null }, ...output.metrics.slice(1)] }]) {
    fetcher.mockResolvedValueOnce(Response.json(result));
    const { compute, emit } = client();
    await expect(compute('compute_rent_comparison', args)).rejects.toMatchObject({ code: 'response' });
    expect(emit).not.toHaveBeenCalled();
  }
});

it('bounds deadlines, propagates cancellation and sanitizes remote errors', async () => {
  const execute = vi.fn(async () => dataset);
  const expired = computationClient(execute, messages, new AbortController().signal, vi.fn(), Date.now() + 1000);
  await expect(expired('compute_rent_comparison', args)).rejects.toMatchObject({ code: 'timeout' });
  const controller = new AbortController(); let called!: AbortSignal;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    called = init!.signal as AbortSignal; controller.abort(); called.throwIfAborted(); return Response.json({});
  });
  const compute = computationClient(execute, messages, controller.signal, vi.fn(), Date.now() + 55000);
  await expect(compute('compute_rent_comparison', args)).rejects.toThrow(); expect(called.aborted).toBe(true);
  vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('secret upstream detail'));
  await expect(client().compute('compute_rent_comparison', args)).rejects.toThrow('Could not reach the calculation service');
});

it('requires explicit compute settings and rejects arbitrary URL components', () => {
  for (const url of ['https://user:pass@compute.test/api/compute', 'http://remote.test/api/compute', 'https://compute.test/api/compute?secret=1', 'https://compute.test/other']) {
    vi.stubEnv('COMPUTE_API_URL', url); expect(() => computeSettings()).toThrow();
  }
});

it('asks for the historical listing period instead of assuming a weekly API amount', async () => {
  const { compute, execute, emit } = client();
  const result = await compute('compute_rent_comparison', { ...args, inputs: { ...args.inputs, reference_period: { value: null, quote: null, message_index: null } } });
  expect(result).toMatchObject({ status: 'needs_input', missing: [{ key: 'reference_period' }] });
  expect(execute).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
  await expect(compute('compute_rent_comparison', { ...args, inputs: { ...args.inputs, reference_period: { value: 'month', quote: '$750 per week', message_index: 0 } } })).rejects.toMatchObject({ code: 'validation' });
});

it('accepts a clarified period from a later user response', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { const p = python(init!.body as string); return Response.json(p.body, { status: p.status }); });
  const history = [{ role: 'user' as const, content: '$750 per week' },
    { role: 'assistant' as const, content: 'What period does the historical listing amount use?' },
    { role: 'user' as const, content: 'The historical listing was monthly.' }];
  const execute = vi.fn(async () => ({ ...dataset, data: { ...dataset.data, price: 3120 } }));
  const compute = computationClient(execute, history, new AbortController().signal, vi.fn(), Date.now() + 55000);
  const result = await compute('compute_rent_comparison', { ...args, inputs: { ...args.inputs,
    reference_period: { value: 'month', quote: 'The historical listing was monthly.', message_index: 2 } } }) as { calculation: Calculation };
  expect(result.calculation.metrics.map(m => m.value)).toEqual([720, 30, 1560, 4.17]);
  expect(result.calculation.userInputs[1]).toMatchObject({ value: 'month', messageIndex: 2 });
});

it('handles missing configuration and oversized or malformed service responses without emitting results', async () => {
  vi.stubEnv('COMPUTE_API_URL', '');
  await expect(client().compute('compute_rent_comparison', args)).rejects.toMatchObject({ code: 'configuration' });
  vi.stubEnv('COMPUTE_API_URL', 'https://compute.example.test/api/compute');
  const fetcher = vi.spyOn(globalThis, 'fetch');
  for (const text of ['invalid JSON', 'x'.repeat(64001)]) {
    fetcher.mockResolvedValueOnce(new Response(text, { headers: { 'Content-Type': 'application/json' } }));
    const { compute, emit } = client();
    await expect(compute('compute_rent_comparison', args)).rejects.toMatchObject({ code: 'response' });
    expect(emit).not.toHaveBeenCalled();
  }
});
