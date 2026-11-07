import './env.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getComputeDatabase } from './db/index.js';
import { ComputeError, runRentalCompute } from './compute.js';
import { validRentalCommand, validRentalContext, type RentalCommand, type RentalContext, type RentalReply } from '../shared/rental.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
export interface SessionStore {
  read(key: string): Promise<any>;
  create(key: string): Promise<void>;
  event(key: string, eventId: string): Promise<any>;
  commit(key: string, revision: number, eventId: string, requestHash: string, state: Record<string, unknown>, artifact: string, reply: RentalReply): Promise<boolean>;
  end(key: string, revision: number): Promise<boolean>;
}
export function sessionStore(signal: AbortSignal): SessionStore {
  const db = getComputeDatabase(AbortSignal.any([signal, AbortSignal.timeout(5000)]));
  return {
    async read(key) { const rows = await db.execute(sql`select * from rental_sessions where token_hash=${key} and expires_at > now()`); return rows.rows[0]; },
    async create(key) { await db.execute(sql`delete from rental_sessions where expires_at <= now()`); await db.execute(sql`insert into rental_sessions(token_hash, expires_at) values (${key}, now()+interval '30 minutes') on conflict do nothing`); },
    async event(key, eventId) { const rows = await db.execute(sql`select request_hash,reply from rental_events where session_hash=${key} and event_id=${eventId}`); return rows.rows[0]; },
    async commit(key, revision, eventId, requestHash, state, artifact, reply) {
      // The update and event insertion are one PostgreSQL statement/transaction. CAS serializes competing workers.
      const rows = await db.execute(sql`with updated as (
        update rental_sessions set revision=${reply.revision},state=${JSON.stringify(state)}::jsonb,
          artifact_version=${artifact},result=${JSON.stringify(reply.result)}::jsonb,expires_at=now()+interval '30 minutes'
        where token_hash=${key} and revision=${revision} and expires_at>now() returning token_hash
      ) insert into rental_events(session_hash,event_id,request_hash,reply)
        select token_hash,${eventId},${requestHash},${JSON.stringify(reply)}::jsonb from updated returning event_id`);
      return rows.rows.length === 1;
    },
    async end(key, revision) { const rows = await db.execute(sql`delete from rental_sessions where token_hash=${key} and revision=${revision} returning token_hash`); return rows.rows.length === 1; },
  };
}
export async function rentalCommand(context: RentalContext, eventId: string, command: RentalCommand,
  signal: AbortSignal, deadlineMs?: number, store = sessionStore(signal)): Promise<RentalReply | { ended: true }> {
  if (!validRentalContext(context) || !id(eventId) || !validRentalCommand(command)) throw new ComputeError('validation', 'Invalid rental request.');
  const key = hash(context.token);
  const requestHash = hash(JSON.stringify({ ...command, operation: command.operation === 'start' ? 'message' : command.operation }));
  if (command.operation === 'start') await store.create(key);
  const saved = await store.read(key);
  if (!saved) {
    if (command.operation === 'end') return { ended: true };
    throw new ComputeError('expired', 'This rental search expired. Start a new chat.');
  }
  if (command.operation === 'end') {
    if (!await store.end(key, context.revision)) throw new ComputeError('conflict', 'The rental search changed. Resume before clearing it.');
    return { ended: true };
  }
  const previous = await store.event(key, eventId);
  if (previous) {
    if (previous.request_hash !== requestHash) throw new ComputeError('conflict', 'This event was already used for a different request.');
    return previous.reply;
  }
  if (command.operation !== 'resume' && (saved.revision !== context.revision || (command.operation === 'start' && saved.revision !== 0)))
    throw new ComputeError('conflict', 'The rental search changed. Resume it before answering.');
  const started = Date.now();
  const computed = await runRentalCompute(command, saved.state, saved.artifact_version, signal, deadlineMs);
  const reply = { revision: saved.revision + 1, result: computed.result };
  if (!await store.commit(key, saved.revision, eventId, requestHash, computed.state, computed.artifactVersion, reply)) {
    const duplicate = await store.event(key, eventId);
    if (duplicate?.request_hash === requestHash) return duplicate.reply;
    throw new ComputeError('conflict', 'The rental search changed. Resume it before answering.');
  }
  console.info(JSON.stringify({ category: 'rental', durationMs: Date.now() - started, action: reply.result.action, reason: reply.result.reason_code,
    artifactVersion: computed.artifactVersion, revision: reply.revision }));
  return reply;
}
export async function rental(request: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
  if (request.method !== 'POST') return Response.json({ error: { code: 'method', message: 'Method not allowed.' } }, { status: 405, headers: { ...headers, Allow: 'POST' } });
  const token = process.env.CHAT_ACCESS_TOKEN;
  if (!token?.trim()) return error(503, 'configuration', 'Rental chat is not configured.');
  if (!timingSafeEqual(Buffer.from(hash(request.headers.get('Authorization') ?? '')), Buffer.from(hash(`Bearer ${token}`))))
    return error(401, 'authentication', 'Chat access was rejected.');
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return error(400, 'validation', 'Send a JSON rental request.');
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  try {
    const reader = request.body?.getReader(); if (!reader) throw new ComputeError('validation', 'Missing request.');
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    let size = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 16000) throw new ComputeError('validation', 'Rental request is too large.'); chunks.push(part.value); }
    } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    signal.throwIfAborted();
    let body: any;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ComputeError('validation', 'Send valid JSON.'); }
    if (!body || Object.keys(body).sort().join(',') !== 'command,context,eventId' || !validRentalContext(body.context)
      || !id(body.eventId) || !validRentalCommand(body.command)) throw new ComputeError('validation', 'Invalid rental request.');
    return Response.json(await rentalCommand(body.context, body.eventId, body.command, signal), { headers });
  } catch (cause) {
    const code = cause instanceof ComputeError ? cause.code : 'unavailable';
    const status = ['conflict', 'stale_snapshot'].includes(code) ? 409 : code === 'expired' ? 410 : code === 'validation' ? 400 : 503;
    return error(status, code, cause instanceof ComputeError ? cause.message : 'Rental planning is unavailable. Please retry.');
  }
}
