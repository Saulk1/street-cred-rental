import { lines, validHistory, type ChatEvent, type ChatMessage } from '../../shared/chat';

declare global { var CHAT_API_CONFIG: { baseUrl?: string; token?: string } | undefined; }

export function chatConfiguration() {
  const config = globalThis.CHAT_API_CONFIG;
  try {
    if (!config?.baseUrl || !config.token || /[\x00-\x20\x7f]/.test(config.token)) return null;
    const origin = new URL(config.baseUrl);
    if (origin.protocol !== 'https:' || origin.origin !== config.baseUrl) return null;
    const manifest = chrome.runtime.getManifest();
    const policy = manifest.content_security_policy;
    const connections = (typeof policy === 'object' ? policy.extension_pages : '')?.split(';')
      .map(p => p.trim().split(/\s+/)).filter(p => p[0] === 'connect-src');
    if (!manifest.host_permissions?.includes(config.baseUrl + '/*') || connections?.length !== 1
      || !connections[0].slice(1).includes(config.baseUrl)) return null;
    return { baseUrl: config.baseUrl, token: config.token };
  } catch { return null; }
}

const source = (s: any) => s && typeof s.id === 'string' && /^S\d{1,3}$/.test(s.id)
  && typeof s.label === 'string' && s.label.length < 300 && typeof s.path === 'string' && s.path.startsWith('/v1/') && s.path.length < 12000;

export function readThread(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length > 80) throw new Error('Invalid saved conversation.');
  return value.map(m => {
    if (!m || typeof m.id !== 'string' || m.id.length > 100 || !['user', 'assistant'].includes(m.role)
      || typeof m.content !== 'string' || m.content.length > 4000
      || !['complete', 'incomplete'].includes(m.state) || !Array.isArray(m.sources)
      || m.sources.length > 30 || !m.sources.every(source)) throw new Error('Invalid saved conversation.');
    return { id: m.id, role: m.role, content: m.content, state: m.state, sources: m.sources };
  });
}

export function contextFor(messages: ChatMessage[]) {
  const context = messages.filter(m => m.state === 'complete' && m.content.trim()).slice(-40)
    .map(({ role, content }) => ({ role, content }));
  while (context.length && !validHistory(context as unknown)) context.shift();
  return context;
}

export async function receiveChat(messages: ChatMessage[], signal: AbortSignal, receive: (event: ChatEvent) => void) {
  const config = chatConfiguration();
  if (!config) throw new Error('Chat is unavailable in this build.');
  const response = await fetch(config.baseUrl + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ messages: contextFor(messages) }), signal, credentials: 'omit', redirect: 'error',
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'Chat access was rejected. Rebuild with the current team settings.'
    : response.status === 429 ? 'Too many requests. Wait a minute before retrying.'
    : response.status === 503 ? 'Chat is not configured on the server yet.' : 'Chat could not be reached. Please retry.');
  if (!response.body || !response.headers.get('Content-Type')?.startsWith('application/x-ndjson')) throw new Error('The chat response was invalid.');
  let characters = 0;
  let events = 0;
  for await (const line of lines(response.body, signal)) {
    if (++events > 10000) throw new Error('The answer was too long.');
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error(event.code === 'limit'
      ? 'This question needs too many lookups. Try a narrower question.' : 'The answer could not be completed. Please retry.');
    if (event.type === 'done') { receive({ type: 'done' }); return; }
    if (event.type === 'delta' && typeof event.text === 'string') {
      characters += event.text.length;
      if (characters > 4000) throw new Error('The answer was too long.');
    } else if (event.type === 'source' && source(event.source)) { /* Valid source. */ }
    else if (event.type === 'tool' && typeof event.id === 'string' && event.id.length <= 200
      && typeof event.label === 'string' && event.label.length < 300 && ['running', 'done', 'error'].includes(event.status)) { /* Valid activity. */ }
    else throw new Error('The chat response was invalid.');
    receive(event as ChatEvent);
  }
  signal.throwIfAborted();
  throw new Error('The connection ended before the answer was complete.');
}
