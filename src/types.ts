export type Note = { id: string; text: string; createdAt: number; type: 'manual' | 'selection' | 'url' };
export type Candidate = { id: string; label: string };
export type LookupError = { message?: string; requestId?: string; retryAt?: number };
export type Basics = { dwelling_type: string | null; bed_count: number | null; bath_count: number | null; parking_count: number | null; land_area_sqm: number | null };
export type Valuation = { predicted_price: number | null; predicted_price_low: number | null; predicted_price_high: number | null; prediction_date: string | null; confidence_score: number | null };
export type Overlay = { on_property: boolean | null; nearest_distance_m: number | null; value?: string | number | null; value_unit?: string | null };
export type Risks = Record<string, Overlay[] | null>;
export type ApiSection<T> = { status: 'ok'; data: T } | { status: 'empty' } | { status: 'error'; error: LookupError };
export type MarketRecord = { date: string | null; price: number | null; type: string | null; address: string | null };
export type MarketPart = 'sale' | 'rent';
export type Market = Record<MarketPart, ApiSection<MarketRecord>>;
export type Planning = {
  zoning_code: { code: string | null; name: string | null; category: string | null } | null;
  zoning_overlays: { layer: string | null; value: string | null }[] | null;
};
export type School = { id: number | null; name: string | null; sector: string | null; school_level_type: string | null; distance_m: number | null };
export type Amenity = { name: string | null; category: string | null; distance_m: number | null };
export type Amenities = { radius_m: number | null; counts: Record<string, number | null>; results: Amenity[] };
export type TransportMode = 'train' | 'tram' | 'bus' | 'ferry';
export type Transport = { radius_m: number | null; counts: Record<string, number | null>; nearest: Record<TransportMode, { name: string | null; label: string | null; distance_m: number | null } | null> };
export type ExtraData = { planning: Planning; schools: School[]; amenities: Amenities; transport: Transport };
export type ExtraKey = 'market' | keyof ExtraData;
export type ExtraResponse<T> = { ok: true; section: ApiSection<T> } | { ok: false; error?: LookupError };
export type MarketResponse = { ok: true; market: Partial<Market> } | { ok: false; error?: LookupError };
export type Sections = { basics?: ApiSection<Basics>; valuation?: ApiSection<Valuation>; risks?: ApiSection<Risks> };
export type LookupResponse = { ok: boolean; candidates?: Candidate[]; sections?: Sections; error?: LookupError };
export const NOTE_PREFIX = 'microburbs.note.';
export function readNotes(stored: Record<string, unknown>): Note[] {
  return Object.entries(stored).filter(([key, value]) => {
    const n = value as Partial<Note> | null;
    return key.startsWith(NOTE_PREFIX) && n && typeof n.id === 'string' && key === NOTE_PREFIX + n.id && typeof n.text === 'string' && Number.isFinite(n.createdAt) && ['manual', 'selection', 'url'].includes(n.type ?? '');
  }).map(([, n]) => n as Note).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
