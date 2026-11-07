import { afterEach, expect, it, vi } from 'vitest';
import { checkDatabase, getDatabase } from '../../server/db';

afterEach(() => vi.unstubAllGlobals());

it('loads without configuration and fails only when a connection is requested', () => {
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('DATABASE_MIGRATION_URL', 'postgresql://owner:secret@owner.invalid/neondb');
  expect(getDatabase).toThrow('DATABASE_URL is not configured.');
});

it('executes a bounded SELECT through the real Drizzle and Neon HTTP drivers', async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://reader:dummy@ep-test.us-east-2.aws.neon.tech/neondb?sslmode=require');
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    fields: [{ name: '?column?', dataTypeID: 23 }],
    rows: [[1]],
    rowCount: 1,
    command: 'SELECT',
    rowAsArray: true,
  }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  await checkDatabase();
  expect(fetchMock).toHaveBeenCalledOnce();
  const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(options.body as string)).toMatchObject({ query: 'select 1', params: [] });
  expect(options.signal).toBeInstanceOf(AbortSignal);
});
