import { afterEach, expect, it, vi } from 'vitest';
import { checkDatabase, getDatabase, getComputeDatabase } from '../../server/db';

afterEach(() => vi.unstubAllGlobals());

it('loads without configuration and fails only when a connection is requested', () => {
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('DATABASE_MIGRATION_URL', 'postgresql://owner:secret@owner.invalid/neondb');
  expect(getDatabase).toThrow('DATABASE_URL is not configured.');
});

it('requires the dedicated compute connection without falling back to the main database', () => {
  vi.stubEnv('COMPUTE_DATABASE_URL', '');
  vi.stubEnv('DATABASE_URL', 'postgresql://reader:dummy@main.invalid/neondb');
  expect(getComputeDatabase).toThrow('COMPUTE_DATABASE_URL is not configured.');
});

it('routes compute queries to the dedicated database', async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://reader:dummy@ep-main.us-east-2.aws.neon.tech/neondb');
  vi.stubEnv('COMPUTE_DATABASE_URL', 'postgresql://writer:dummy@ep-compute.us-east-2.aws.neon.tech/neondb');
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    fields: [{ name: '?column?', dataTypeID: 23 }], rows: [[1]], rowCount: 1, command: 'SELECT', rowAsArray: true,
  }));
  vi.stubGlobal('fetch', fetchMock);
  const { sql } = await import('drizzle-orm');
  await getComputeDatabase().execute(sql`select 1`);
  const options = fetchMock.mock.calls[0][1] as unknown as RequestInit;
  const headers = new Headers(options.headers);
  expect(headers.get('Neon-Connection-String')).toContain('@ep-compute.');
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
