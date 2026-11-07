import { beforeEach, describe, expect, it, vi } from 'vitest';
import endpoint from '../../api/health';
import { checkDatabase } from '../../server/db';

vi.mock('../../server/db', () => ({ checkDatabase: vi.fn() }));

beforeEach(() => { vi.mocked(checkDatabase).mockReset(); });

describe('GET /api/health', () => {
  it('checks the database and returns an uncached success response', async () => {
    vi.mocked(checkDatabase).mockResolvedValue(undefined);
    const response = await endpoint.fetch(new Request('https://example.test/api/health'));
    expect(checkDatabase).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it.each(['DATABASE_URL is not configured.', 'postgresql://user:secret@private-host/db', 'TimeoutError'])(
    'returns a generic 503 without leaking failure details: %s', async (message) => {
      vi.mocked(checkDatabase).mockRejectedValue(new Error(message));
      const response = await endpoint.fetch(new Request('https://example.test/api/health'));
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ status: 'unavailable' });
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])(
    'rejects %s without opening a database connection', async (method) => {
      const response = await endpoint.fetch(new Request('https://example.test/api/health', { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET');
      expect(await response.json()).toEqual({ error: 'Method not allowed' });
      expect(checkDatabase).not.toHaveBeenCalled();
    },
  );
});
