import { expect, it, vi } from 'vitest';
import { propertyClient } from '../../server/property';

const settings = { baseUrl: 'https://property.example.test', apiKey: 'dummy-key' };
it('only uses supported paths, preserves missing/zero values and distinguishes partial failures', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url).includes('/geocode/')) return Response.json({ data: [{ id: 'GANSW1', name: 'Test address' }] });
    if (String(url).endsWith('/valuation/avm')) return new Response(null, { status: 503 });
    return Response.json({ data: { bed_count: 0, flood: [{ on_property: false, nearest_distance_m: 0 }], unexpected_secret: 'excluded' } });
  });
  const execute = propertyClient(settings, new AbortController().signal, vi.fn());
  await expect(execute('property_details', { id: 'GANSW1' })).rejects.toThrow('Search the address');
  await execute('search_address', { address: 'Test address' });
  const result = await execute('property_details', { id: 'GANSW1' }) as any;
  expect(result.basics.data.bed_count).toBe(0);
  expect(result.valuation).toMatchObject({ status: 'error', code: 'server' });
  expect(result.risks.data.flood[0]).toMatchObject({ on_property: false, nearest_distance_m: 0 });
  expect(JSON.stringify(result)).not.toContain('excluded');
  await expect(execute('property_section', { id: 'GANSW1', section: '__proto__', part: null })).rejects.toThrow('supported');
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it('honours Retry-After across subsequent tool calls without automatically retrying', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '60' } }));
  const execute = propertyClient(settings, new AbortController().signal, vi.fn());
  await expect(execute('search_address', { address: 'Test address' })).rejects.toMatchObject({ code: 'rate_limit' });
  await expect(execute('search_address', { address: 'Another address' })).rejects.toMatchObject({ code: 'rate_limit' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([[401, 'authentication'], [403, 'coverage'], [422, 'validation'], [503, 'server']])('maps HTTP %s safely', async (status, code) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private upstream message', { status: Number(status) }));
  const execute = propertyClient(settings, new AbortController().signal, vi.fn());
  await expect(execute('search_address', { address: 'Test address' })).rejects.toMatchObject({ code });
});
