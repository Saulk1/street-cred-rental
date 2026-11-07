import { validRentalReply, type RentalContext, type RentalCommand, type RentalReply } from '../../../shared/rental';
import { lines, validHistory, type ChatEvent, type ChatMessage } from '../../../shared/chat';
import { validCalculation } from '../../../shared/compute';

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
    if (m.rental !== undefined && !validRentalReply(m.rental)) throw new Error('Invalid saved rental result.');
    const calculations = m.calculations ?? [];
    if (!Array.isArray(calculations) || calculations.length > 6 || !calculations.every(validCalculation)
      || new Set(calculations.map(c => c.id)).size !== calculations.length
      || calculations.some(c => c.apiInputs.some(d => !m.sources.some((s: { id: string }) => s.id === d.sourceId)))) throw new Error('Invalid saved calculations.');
    return { id: m.id, role: m.role, content: m.content, state: m.state, sources: m.sources, calculations, ...(m.rental === undefined ? {} : { rental: m.rental }) };
  });
}

export function contextFor(messages: ChatMessage[]) {
  const context = messages.filter(m => m.state === 'complete' && m.content.trim()).slice(-40)
    .map(({ role, content }) => ({ role, content }));
  while (context.length && !validHistory(context as unknown)) context.shift();
  return context;
}

export async function receiveChat(messages: ChatMessage[], signal: AbortSignal, receive: (event: ChatEvent) => void, rental?: RentalContext) {
  const config = chatConfiguration();
  if (!config) throw new Error('Chat is unavailable in this build.');
  const response = await fetch(config.baseUrl + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ messages: contextFor(messages), ...(rental ? { rental, eventId: messages.at(-1)!.id } : {}) }), signal, credentials: 'omit', redirect: 'error',
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'Chat access was rejected. Rebuild with the current team settings.'
    : response.status === 429 ? 'Too many requests. Wait a minute before retrying.'
    : response.status === 503 ? 'Chat is not configured on the server yet.' : 'Chat could not be reached. Please retry.');
  if (!response.body || !response.headers.get('Content-Type')?.startsWith('application/x-ndjson')) throw new Error('The chat response was invalid.');
  let characters = 0;
  let events = 0;
  const sources = new Set<string>();
  const calculations = new Set<string>();
  for await (const line of lines(response.body, signal)) {
    if (++events > 10000) throw new Error('The answer was too long.');
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error(event.code === 'limit'
      ? 'This question needs too many lookups. Try a narrower question.' : 'The answer could not be completed. Please retry.');
    if (event.type === 'done') { receive({ type: 'done' }); return; }
    if (event.type === 'delta' && typeof event.text === 'string') {
      characters += event.text.length;
      if (characters > 4000) throw new Error('The answer was too long.');
    } else if (event.type === 'source' && source(event.source) && sources.size < 30 && !sources.has(event.source.id)) {
      sources.add(event.source.id);
    } else if (event.type === 'calculation' && validCalculation(event.calculation) && calculations.size < 6
      && !calculations.has(event.calculation.id) && event.calculation.apiInputs.every((d: { sourceId: string }) => sources.has(d.sourceId))) {
      calculations.add(event.calculation.id);
    }
    else if (event.type === 'rental_result' && validRentalReply(event.rental)) { /* Valid advisor result. */ }
    else if (event.type === 'tool' && typeof event.id === 'string' && event.id.length <= 200
      && typeof event.label === 'string' && event.label.length < 300 && ['running', 'done', 'error'].includes(event.status)) { /* Valid activity. */ }
    else throw new Error('The chat response was invalid.');
    receive(event as ChatEvent);
  }
  signal.throwIfAborted();
  throw new Error('The connection ended before the answer was complete.');
}

export const RENTAL_KEY = 'property-rental:v1';
export function newRentalContext(): RentalContext {
  return { token: Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''), revision: 0 };
}
export async function rentalRequest(context: RentalContext, command: RentalCommand, signal?: AbortSignal, eventId: string = crypto.randomUUID()): Promise<RentalReply | { ended: true }> {
  const config = chatConfiguration();
  if (!config) throw new Error('Rental chat is unavailable in this build.');
  const response = await fetch(config.baseUrl + '/api/rental', { method: 'POST', credentials: 'omit', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ context, command, eventId }) });
  const body = await response.json();
  if (!response.ok) throw new Error(response.status === 409 ? 'This rental search changed. Resume it before answering.'
    : response.status === 410 ? 'This rental search expired. Start a new chat.' : 'Rental planning is unavailable. Please retry.');
  if (body?.ended === true && command.operation === 'end') return body;
  if (!validRentalReply(body)) throw new Error('The rental response was invalid.');
  return body;
}
