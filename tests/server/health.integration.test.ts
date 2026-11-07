import { expect, it, vi } from 'vitest';
import endpoint from '../../api/health';

// Opt-in only: explicitly target a development Neon branch, never production.
it.skipIf(!process.env.TEST_DATABASE_URL)('reaches a development Neon database', async () => {
  vi.stubEnv('DATABASE_URL', process.env.TEST_DATABASE_URL!);
  const response = await endpoint.fetch(new Request('http://localhost/api/health'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
}, 10_000);
