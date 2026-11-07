export type ChatInput = { role: 'user' | 'assistant'; content: string };
export type ChatSource = { id: string; label: string; path: string };
export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; label: string; status: 'running' | 'done' | 'error' }
  | { type: 'source'; source: ChatSource }
  | { type: 'done' }
  | { type: 'error'; code: string; message: string };

export const CHAT_KEY = 'property-chat:v1';
export type ChatMessage = ChatInput & {
  id: string;
  state: 'complete' | 'incomplete';
  sources: ChatSource[];
};

export function validHistory(value: unknown): value is ChatInput[] {
  if (!Array.isArray(value) || !value.length || value.length > 40) return false;
  let length = 0;
  return value.every(m => {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string'
      || !m.content.trim() || m.content.length > 4000) return false;
    length += m.content.length;
    return length <= 64000;
  }) && value.at(-1).role === 'user';
}

// Byte chunks can split either UTF-8 characters or JSON lines.
export async function* lines(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => { void reader.cancel(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 262144) throw new Error('Response exceeded the line limit.');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) yield line;
      }
      if (done) { if (buffer.trim()) yield buffer.trim(); break; }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
