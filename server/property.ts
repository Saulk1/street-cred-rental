import './env.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatSource } from '../shared/chat.js';

export class PropertyError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function propertySettings() {
  const base = process.env.MICROBURBS_API_BASE_URL ?? '';
  const apiKey = process.env.MICROBURBS_API_KEY ?? '';
  const url = new URL(base);
  if (url.protocol !== 'https:' || !/^[A-Za-z0-9.-]+$/.test(url.hostname) || url.username || url.password
    || url.search || url.hash || url.port || !/^\/*$/.test(url.pathname) || !apiKey.trim()
    || /[\x00-\x20\x7f]/.test(apiKey)) throw new Error('Invalid property configuration.');
  return { baseUrl: url.origin, apiKey };
}

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.slice(0, 1000) : null;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const invalid = () => new PropertyError('response', 'Microburbs returned an unexpected response.');
const pick = (data: unknown, fields: Record<string, (value: unknown) => unknown>) => {
  if (!object(data)) throw invalid();
  return Object.fromEntries(Object.entries(fields).map(([key, normalise]) => [key, normalise(data[key])]));
};
const rows = (data: unknown, fields: Record<string, (value: unknown) => unknown>) => {
  if (!Array.isArray(data)) throw invalid();
  return data.filter(object).slice(0, 50).map(row => pick(row, fields));
};
const counts = (data: unknown) => object(data) ? Object.fromEntries(Object.entries(data).slice(0, 30).map(([key, n]) => [key, number(n)])) : {};

function normalise(section: string, data: unknown): unknown {
  if (section === 'basics') return pick(data, { dwelling_type: text, bed_count: number, bath_count: number, parking_count: number, land_area_sqm: number });
  if (section === 'valuation') return pick(data, { predicted_price: number, predicted_price_low: number, predicted_price_high: number, prediction_date: text, confidence_score: v => (number(v) ?? 101) <= 100 ? number(v) : null });
  if (section === 'risks') {
    if (!object(data)) throw invalid();
    return Object.fromEntries(['bushfire', 'flood', 'historical_flood', 'heritage', 'public_housing', 'landslide', 'erosion', 'environment', 'hv_power_line', 'mobile_black_spot'].map(key => [key,
      Array.isArray(data[key]) ? rows(data[key], { name: text, value: v => text(v) ?? number(v), value_unit: text, on_property: v => typeof v === 'boolean' ? v : null, nearest_distance_m: number, search_radius_m: number }) : null]));
  }
  if (section === 'market') return pick(data, { date: text, price: number, type: text, address: text });
  if (section === 'planning') {
    if (!object(data)) throw invalid();
    return { zoning_code: object(data.zoning_code) ? pick(data.zoning_code, { code: text, name: text, category: text }) : null,
      zoning_overlays: Array.isArray(data.zoning_overlays) ? rows(data.zoning_overlays, { layer: text, value: text }) : null };
  }
  if (section === 'schools') return rows(data, { id: number, name: text, sector: text, school_level_type: text, distance_m: number }).sort(byDistance);
  if (!object(data)) throw invalid();
  if (section === 'amenities') return { radius_m: number(data.radius_m), counts: counts(data.counts), results: rows(data.results, { name: text, category: text, distance_m: number }).sort(byDistance) };
  if (!object(data.nearest)) throw invalid();
  return { radius_m: number(data.radius_m), counts: counts(data.counts), nearest: Object.fromEntries(['train', 'tram', 'bus', 'ferry'].map(mode => [mode,
    object(data.nearest[mode]) ? pick(data.nearest[mode], { name: text, label: text, distance_m: number }) : null])) };
}

function byDistance(a: Record<string, unknown>, b: Record<string, unknown>) {
  return (typeof a.distance_m === 'number' ? a.distance_m : Infinity) - (typeof b.distance_m === 'number' ? b.distance_m : Infinity);
}

// Request-local throttling; Retry-After stops this turn instead of retrying upstream.
export function propertyClient(settings: ReturnType<typeof propertySettings>, signal: AbortSignal,
  source: (value: ChatSource) => void) {
  let next = 0;
  let retryAt = 0;
  let sequence = 0;
  const known = new Set<string>();
  const cache = new Map<string, unknown>();
  async function request(path: string, label: string, section: string) {
    if (cache.has(path)) return cache.get(path) as { source: ChatSource; status: string; data: any; retrievedAt: string };
    if (Date.now() < retryAt) throw new PropertyError('rate_limit', 'Microburbs is rate limiting requests. Please wait before retrying.');
    if (next > Date.now()) await delay(next - Date.now(), undefined, { signal });
    next = Date.now() + 125;
    const response = await fetch(settings.baseUrl + path, {
      headers: { Authorization: `Bearer ${settings.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), redirect: 'error', credentials: 'omit',
    });
    if (!response.ok) {
      if (response.status === 429) {
        const header = response.headers.get('Retry-After');
        const seconds = header === null ? NaN : Number(header);
        retryAt = Number.isFinite(seconds) ? Date.now() + Math.max(1, seconds) * 1000 : Math.max(Date.now() + 1000, Date.parse(header ?? '') || 0);
      }
      const [code, message] = response.status === 429 ? ['rate_limit', 'Microburbs is rate limiting requests. Please wait before retrying.']
        : response.status === 401 ? ['authentication', 'The property service credentials were rejected.']
        : response.status === 403 ? ['coverage', 'Outside City of Sydney coverage, or this endpoint is unavailable.']
        : response.status === 422 ? ['validation', 'Microburbs could not process this address or identifier.']
        : ['server', 'Microburbs is unavailable. Please retry.'];
      throw new PropertyError(code, message);
    }
    const envelope = await response.json();
    if (!object(envelope) || !Object.hasOwn(envelope, 'data')) throw invalid();
    const data = envelope.data === null ? null : section === 'search'
      ? rows(envelope.data, { id: v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v) ? v : null,
        display_name: v => text(v), name: text, abbr: text, property_type: text }).filter(row => row.id).slice(0, 10)
      : normalise(section, envelope.data);
    const reference = { id: `S${++sequence}`, label, path };
    source(reference);
    if (section === 'search' && Array.isArray(data)) for (const row of data) known.add(row.id as string);
    const result = { source: reference, status: data === null ? 'empty' : 'ok', data, retrievedAt: new Date().toISOString() };
    cache.set(path, result);
    return result;
  }
  return async (name: string, args: Record<string, unknown>) => {
    if (name === 'search_address') {
      if (Object.keys(args).length !== 1 || typeof args.address !== 'string' || args.address.trim().length < 2 || args.address.length > 1000) throw new PropertyError('validation', 'Enter a full address.');
      return request(`/v1/geocode/address?${new URLSearchParams({ address: args.address })}`, 'Address matches', 'search');
    }
    if (typeof args.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(args.id) || !known.has(args.id)) throw new PropertyError('validation', 'Search the address in this turn before retrieving a property.');
    const prefix = `/v1/properties/${encodeURIComponent(args.id)}`;
    if (name === 'property_details' && Object.keys(args).length === 1) {
      const result: Record<string, unknown> = {};
      for (const [key, path] of [['basics', '/basics/all'], ['valuation', '/valuation/avm'], ['risks', '/risks/all']]) {
        try { result[key] = await request(prefix + path, `${args.id} · ${key}`, key); }
        catch (error) { signal.throwIfAborted(); result[key] = safePropertyError(error); }
      }
      return result;
    }
    const endpoints: Record<string, string> = { planning: '/development/all', schools: '/schools/nearby', amenities: '/amenities/nearby?radius_m=1000', transport: '/transport/nearby?radius_m=1000' };
    if (name !== 'property_section' || Object.keys(args).sort().join() !== 'id,part,section'
      || typeof args.section !== 'string' || !['market', ...Object.keys(endpoints)].includes(args.section)
      || (args.section === 'market' ? !['sale', 'rent'].includes(String(args.part)) : args.part !== null)) throw new PropertyError('validation', 'Choose a supported property section.');
    return request(prefix + (args.section === 'market' ? `/${args.part}-history-latest` : endpoints[args.section]), `${args.id} · ${args.section}${args.part ? ' · ' + args.part : ''}`, args.section);
  };
}

export function safePropertyError(error: unknown) {
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
    return { status: 'error', code: 'timeout', message: 'The Microburbs request timed out. Please retry.' };
  }
  return { status: 'error', code: error instanceof PropertyError ? error.code : 'network',
    message: error instanceof PropertyError ? error.message : 'Could not reach Microburbs. Please retry.' };
}
