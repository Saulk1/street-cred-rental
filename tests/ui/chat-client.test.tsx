import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { receiveChat } from '../../src/lib/chat';

const history = [{ id: 'user', role: 'user' as const, content: '你好', state: 'complete' as const, sources: [] }];
beforeEach(() => {
  vi.stubGlobal('CHAT_API_CONFIG', { baseUrl: 'https://chat.example.test', token: 'dummy-token' });
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ host_permissions: ['https://chat.example.test/*'], content_security_policy: { extension_pages: 'connect-src https://chat.example.test' } }) } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function response(text: string, byteChunks = false) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(c) {
    if (byteChunks) for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
    else c.enqueue(bytes);
    c.close();
  } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
}

it('decodes split UTF-8 characters and multiple JSON lines without losing text', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('{"type":"delta","text":"你好悉尼"}\r\n{"type":"done"}\n', true));
  const receive = vi.fn();
  await receiveChat(history, new AbortController().signal, receive);
  expect(receive.mock.calls.map(([e]) => e)).toEqual([{ type: 'delta', text: '你好悉尼' }, { type: 'done' }]);
});

it.each([
  '{"type":"delta","text":"Partial"}\n',
  '{"type":"provider-secret","value":"must-not-render"}\n',
  '{"type":"delta","text":123}\n',
  'invalid JSON\n',
  JSON.stringify({ type: 'delta', text: 'x'.repeat(4001) }) + '\n',
])('rejects truncated, malformed and oversized answers', async text => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(text));
  await expect(receiveChat(history, new AbortController().signal, vi.fn())).rejects.toThrow();
});
