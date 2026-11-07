import './env.mjs';
import rawCatalog from '../compute/catalog.json' with { type: 'json' };
import type { Tool } from 'openai/resources/responses/responses';
import type { ChatInput } from '../shared/chat.js';
import { object, textList, validCalculation, type Calculation, type CalculationDataset, type CalculationInput } from '../shared/compute.js';
import { PropertyError } from './property.js';

type InputField = { key: string; label: string; unit: string } & (
  { type: 'number'; minimum: number; maximum: number } | { type: 'enum'; options: string[]; evidence: Record<string, string[]> });
type Contract = { id: string; version: string; title: string; description: string; inputs: InputField[];
  datasets: { key: string; section: string; part: string | null; coverage: string }[];
  metrics: { key: string; label: string; unit: string }[] };
const catalog = rawCatalog as Contract[];

export const computationTools: Tool[] = catalog.map(contract => ({
  type: 'function', name: `compute_${contract.id}`, description: contract.description, strict: true,
  parameters: { type: 'object', additionalProperties: false, required: ['id', 'inputs'], properties: {
    id: { type: 'string', description: 'Property ID returned by search_address in this turn.' },
    inputs: { type: 'object', additionalProperties: false, required: contract.inputs.map(f => f.key),
      properties: Object.fromEntries(contract.inputs.map(field => [field.key, {
        type: 'object', additionalProperties: false, required: ['value', 'quote', 'message_index'], properties: {
          value: field.type === 'number' ? { type: ['number', 'null'], description: `${field.label} (${field.unit}), ${field.minimum}–${field.maximum}. Null if not supplied.` }
            : { type: ['string', 'null'], enum: [...field.options, null], description: `${field.label}; must be explicitly confirmed by the user. Null if missing.` },
          quote: { type: ['string', 'null'], description: 'Short exact quote from the user supporting this value. Null if missing.' },
          message_index: { type: ['integer', 'null'], description: 'Zero-based message index in the supplied conversation. Must identify a user message.' },
        },
      }])) },
  } },
}));

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

function exactKeys(value: unknown, keys: string[]): value is Record<string, any> {
  return object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
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

type Execute = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export function computationClient(executeProperty: Execute, messages: ChatInput[], signal: AbortSignal,
  emit: (calculation: Calculation) => void, deadlineMs: number) {
  let sequence = 0;
  return async (tool: string, args: Record<string, unknown>) => {
    const contract = catalog.find(item => `compute_${item.id}` === tool);
    if (!contract || !exactKeys(args, ['id', 'inputs']) || typeof args.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(args.id)
      || !exactKeys(args.inputs, contract.inputs.map(f => f.key))) throw new ComputeError('validation', 'Choose a supported calculator and property.');
    const missing: { key: string; label: string; unit: string }[] = [];
    const userInputs: CalculationInput[] = [];
    const inputs: Record<string, number | string> = {};
    for (const field of contract.inputs) {
      const supplied = args.inputs[field.key];
      if (!exactKeys(supplied, ['value', 'quote', 'message_index'])) throw new ComputeError('validation', 'Supply a value and supporting user quote for each input.');
      if (supplied.value === null) { missing.push({ key: field.key, label: field.label, unit: field.unit }); continue; }
      if (field.type === 'number' && (typeof supplied.value !== 'number' || !Number.isFinite(supplied.value) || supplied.value < field.minimum || supplied.value > field.maximum))
        throw new ComputeError('validation', `${field.label} must be a finite number between ${field.minimum} and ${field.maximum} ${field.unit}.`);
      if (field.type === 'enum' && (typeof supplied.value !== 'string' || !field.options.includes(supplied.value)))
        throw new ComputeError('validation', `Choose a supported ${field.label.toLowerCase()}.`);
      const message = Number.isInteger(supplied.message_index) && supplied.message_index >= 0 ? messages[supplied.message_index] : null;
      const quote = supplied.quote;
      const numbers = typeof quote === 'string' ? [...quote.matchAll(/(?<![\p{L}\d.])[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?![\d.])/gu)] : [];
      const evidence = field.type === 'number' ? numbers.some(match => Number(match[0].replaceAll(',', '')) === supplied.value)
        : typeof quote === 'string' && field.evidence[supplied.value]?.some(term => /[^\x00-\x7f]/.test(term)
          ? quote.includes(term) : new RegExp(`\\b${term}\\b`, 'i').test(quote));
      if (message?.role !== 'user' || typeof quote !== 'string' || !quote.trim() || quote.length > 400 || !message.content.includes(quote)
        || !evidence)
        throw new ComputeError('validation', `Ask the user for ${field.label.toLowerCase()} in ${field.unit}; include an exact quote supporting the value.`);
      inputs[field.key] = supplied.value;
      userInputs.push({ key: field.key, label: field.label, value: supplied.value, unit: field.unit, quote, messageIndex: supplied.message_index });
    }
    if (missing.length) return { status: 'needs_input', missing, message: 'Ask the user for these values and their units before calculating.' };
    let settings: ReturnType<typeof computeSettings>;
    try { settings = computeSettings(); }
    catch { throw new ComputeError('configuration', 'Calculations are not configured on the server yet. Property lookups are still available.'); }
    // Dataset declarations are checked-in server configuration, never model arguments.
    const datasets: Record<string, unknown> = {};
    const apiInputs: CalculationDataset[] = [];
    for (const dataset of contract.datasets) {
      const reply = await executeProperty('property_section', { id: args.id, section: dataset.section, part: dataset.part });
      if (!object(reply) || reply.status !== 'ok' || !object(reply.data))
        return { status: 'unavailable', message: 'The required Microburbs dataset is unavailable; no calculation was performed.', dataset: dataset.key };
      if (!object(reply.source) || typeof reply.source.id !== 'string' || typeof reply.retrievedAt !== 'string') throw new ComputeError('response', 'The property dataset has no source metadata.');
      datasets[dataset.key] = reply.data;
      apiInputs.push({ key: dataset.key, sourceId: reply.source.id, retrievedAt: reply.retrievedAt, coverage: dataset.coverage, data: structuredClone(reply.data) });
    }
    signal.throwIfAborted();
    // Leave time for the model to explain results before the chat's 55s deadline.
    const timeout = Math.min(8000, deadlineMs - Date.now() - 5000);
    if (timeout < 1000) throw new ComputeError('timeout', 'Not enough time remains for this calculation. Please retry the question.');
    const computeSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    let result: unknown;
    try {
      const response = await fetch(settings.url, { method: 'POST', headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ calculator: contract.id, version: contract.version, inputs, datasets, deadlineMs: Date.now() + timeout }),
        credentials: 'omit', redirect: 'error', signal: computeSignal });
      if (!response.ok) throw new ComputeError('service', response.status === 401 || response.status === 503
        ? 'The calculation service is not configured correctly.' : 'The calculation service could not complete the request.');
      result = await boundedJson(response, computeSignal);
    } catch (error) {
      signal.throwIfAborted();
      if (computeSignal.aborted) throw new ComputeError('timeout', 'The calculation timed out. Please retry.');
      if (error instanceof ComputeError) throw error;
      throw new ComputeError('service', 'Could not reach the calculation service. Please retry.');
    }
    if (object(result) && result.calculator === contract.id && result.version === contract.version && result.status === 'unavailable'
      && typeof result.message === 'string' && result.message.length <= 1000) return { status: 'unavailable', message: result.message };
    if (!object(result) || result.status !== 'ok' || result.calculator !== contract.id || result.version !== contract.version
      || !Array.isArray(result.metrics) || result.metrics.length !== contract.metrics.length || !textList(result.assumptions) || !textList(result.warnings)
      || !contract.metrics.every((field, index) => object(result.metrics[index]) && result.metrics[index].key === field.key
        && result.metrics[index].label === field.label && result.metrics[index].unit === field.unit))
      throw new ComputeError('response', 'The calculation service returned an invalid result.');
    const calculation: Calculation = { id: `C${++sequence}`, calculator: contract.id, version: contract.version, title: contract.title,
      propertyId: args.id, computedAt: new Date().toISOString(), userInputs, apiInputs,
      metrics: result.metrics, assumptions: result.assumptions, warnings: result.warnings };
    if (!validCalculation(calculation)) throw new ComputeError('response', 'The calculation service returned an invalid result.');
    emit(calculation);
    return { status: 'ok', calculation };
  };
}
