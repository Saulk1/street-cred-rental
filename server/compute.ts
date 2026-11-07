import './env.mjs';
import type { Tool } from 'openai/resources/responses/responses';
import { PropertyError } from './property.js';
import type { RentalCommand, RentalComputeReply } from '../shared/rental.js';
import { validRentalResult } from '../shared/rental.js';
export class ComputeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function safeComputeError(error: unknown) {
  return { status: 'error', code: error instanceof ComputeError || error instanceof PropertyError ? error.code : 'calculation',
    message: error instanceof ComputeError || error instanceof PropertyError ? error.message : 'The calculation could not be completed. Please retry.' };
}

export function computeSettings() {
  const value = process.env.COMPUTE_API_URL ?? '';
  const token = process.env.COMPUTE_SERVICE_TOKEN ?? '';
  const url = new URL(value);
  const local = process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash
    || url.pathname !== '/api/compute' || value !== url.href || !/^[A-Za-z0-9.-]+$/.test(url.hostname)
    || token.length < 32 || /[^\x21-\x7e]/.test(token)) throw new Error('Invalid compute settings.');
  return { url: value, token };
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || !response.headers.get('Content-Type')?.startsWith('application/json')) throw new ComputeError('response', 'The calculation service returned an invalid response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64000) throw new ComputeError('response', 'The calculation service returned too much data.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ComputeError('response', 'The calculation service returned invalid JSON.'); }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}


export const computationTools: Tool[] = [{ type: 'function', name: 'compute_rental_advisor',
  description: 'Find rentals, ask useful preference questions, recommend three differentiated homes, or update a rental search. Uses a dated private snapshot. The server supplies the latest user message; no address search is required.',
  strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }];

export async function runRentalCompute(command: RentalCommand, state: Record<string, unknown> | null,
  artifactVersion: string | null, signal: AbortSignal, deadlineMs = Date.now() + 55000): Promise<RentalComputeReply> {
  let settings: ReturnType<typeof computeSettings>;
  try { settings = computeSettings(); }
  catch { throw new ComputeError('configuration', 'Rental computations are not configured on the server.'); }
  const timeout = Math.min(8000, deadlineMs - Date.now() - 5000);
  if (timeout < 1000) throw new ComputeError('timeout', 'Not enough time remains. Please retry.');
  const computeSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  try {
    const response = await fetch(settings.url, { method: 'POST', headers: {
      Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ calculator: 'rental_advisor', version: '1.0.0', command, state, artifactVersion,
        deadlineMs: Date.now() + timeout }), credentials: 'omit', redirect: 'error', signal: computeSignal });
    const value = await boundedJson(response, computeSignal) as any;
    if (!response.ok) {
      const codes = ['validation', 'version', 'timeout', 'unavailable', 'stale_snapshot', 'conflict'];
      const code = codes.includes(value?.error?.code) ? value.error.code : 'service';
      const messages: Record<string, string> = { validation: 'The rental request is invalid.', version: 'Redeploy matching compute versions.',
        timeout: 'Rental planning timed out. Please retry.', unavailable: 'The private rental snapshot is unavailable.',
        stale_snapshot: 'Rental data changed. Start a new chat.', conflict: 'This question is no longer current. Resume the search.' };
      throw new ComputeError(code, messages[code] ?? 'The rental compute service is unavailable.');
    }
    if (value?.calculator !== 'rental_advisor' || value.version !== '1.0.0' || value.status !== 'ok'
      || !value.state || typeof value.state !== 'object' || Array.isArray(value.state) || value.state.schema !== 1 || JSON.stringify(value.state).length > 40000
      || typeof value.artifactVersion !== 'string' || !/^[a-f0-9]{64}$/.test(value.artifactVersion)
      || !validRentalResult(value.result) || value.result.provenance.artifactVersion !== value.artifactVersion)
      throw new ComputeError('response', 'The rental service returned an invalid result.');
    return value;
  } catch (error) {
    signal.throwIfAborted();
    if (computeSignal.aborted) throw new ComputeError('timeout', 'Rental planning timed out. Please retry.');
    if (error instanceof ComputeError) throw error;
    throw new ComputeError('service', 'Could not reach the rental computation service.');
  }
}
