import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRightIcon, BookmarkIcon, CheckIcon, FlameIcon, HeartPulseIcon, HouseIcon, KeyRoundIcon, LeafIcon, MapPinIcon, Share2Icon, ShoppingCartIcon, TrainFrontIcon, TreePineIcon, Volume2Icon, WavesIcon } from 'lucide-react';
import { calculateWellbeing } from '@/lib/wellbeing';
import type { ReportSnapshot } from '@/property-report';
import type { Candidate } from '@/types';

type RecordData = Record<string, unknown>;
const record = (value: unknown): RecordData => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : {};
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const money = (value: unknown) => number(value) === null ? 'Not available' : new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(value as number);
const shortMoney = (value: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', notation: 'compact', maximumFractionDigits: 0 }).format(value);
const distance = (value: unknown) => number(value) === null || (value as number) < 0 ? null : (value as number) < 1000 ? `${Math.round(value as number)} m` : `${((value as number) / 1000).toFixed(1)} km`;
function date(value: unknown) {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Summary cards read saved envelopes, never starting duplicate upstream calls.
function useReportData(report: ReportSnapshot, suffix: string, scope = 'properties') {
  const task = report.tasks.find(item => item.endpoint.startsWith(`/v1/${scope}/`) && item.endpoint.endsWith(suffix));
  const key = `${report.id}:${task?.id}:${task?.savedAt}:${task?.status}`;
  const [result, setResult] = useState<{ key: string; data?: unknown; error?: boolean }>();
  useEffect(() => {
    let active = true;
    if (task?.status !== 'ok') return;
    void (async () => {
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'REPORT_RESULT', reportId: report.id, taskId: task.id });
        if (active) setResult({ key, data: reply?.ok ? reply.result?.data : undefined, error: !reply?.ok || !reply.result });
      } catch { if (active) setResult({ key, error: true }); }
    })();
    return () => { active = false; };
  }, [key, report.id, task?.id, task?.status]);
  const current = result?.key === key ? result : undefined;
  return { data: current?.data, loading: task?.status === 'pending' || task?.status === 'loading' || task?.status === 'ok' && !current, failed: task?.status === 'error' || !!current?.error };
}
type SavedData = ReturnType<typeof useReportData>;
function Unavailable({ source }: { source: SavedData }) {
  return <p className="overview-muted" aria-busy={source.loading || undefined}>{source.loading ? 'Loading saved data…' : source.failed ? 'Could not load this data. Retry it in the full report below.' : 'No data returned for this address.'}</p>;
}
function SectionCard({ title, caption, children, footer }: { title: string; caption?: string; children: ReactNode; footer?: ReactNode }) {
  return <article className="overview-card"><header className="overview-section-heading"><h2>{title}</h2>{caption && <span className="overview-caption">{caption}</span>}</header>{children}{footer && <footer>{footer}</footer>}</article>;
}

function Valuation({ source, sale }: { source: SavedData; sale: SavedData }) {
  const data = record(source.data), last = record(sale.data);
  const price = number(data.predicted_price), low = number(data.predicted_price_low), high = number(data.predicted_price_high), confidence = number(data.confidence_score);
  const marker = price !== null && low !== null && high !== null && high > low ? Math.max(0, Math.min(100, (price - low) / (high - low) * 100)) : null;
  return <article className="overview-card valuation-card"><header><p className="overview-eyebrow">Estimated property value</p><h2 className="overview-price">{source.loading ? 'Loading…' : price === null ? 'Not available' : money(price)}</h2></header>
    {source.loading || price === null ? <Unavailable source={source} /> : <>
      {marker !== null && low !== null && high !== null && <div className="valuation-interval"><div className="valuation-range" aria-hidden="true"><span /><i style={{ '--marker': `${marker}%` } as CSSProperties} /></div><div className="range-labels"><span>Low <strong title={money(low)}>{shortMoney(low)}</strong></span><span>80% valuation range</span><span>High <strong title={money(high)}>{shortMoney(high)}</strong></span></div></div>}
      <div className="overview-confidence"><span>Confidence</span>{confidence !== null && confidence >= 0 && confidence <= 100 ? <><meter min={0} max={100} value={confidence} aria-label="Model confidence" /><strong>{confidence} / 100</strong></> : <strong>Not available</strong>}</div>
    </>}
    <div className="overview-detail-row sale-observation"><div><h3>{text(last.type)?.toLowerCase() === 'sold' ? 'Last sale' : 'Latest sale listing'}</h3><p className="overview-muted">{[text(last.type), date(last.date)].filter(Boolean).join(' · ') || 'No sale record returned'}</p></div><strong>{money(last.price)}</strong></div>
    <p className="overview-caption">{date(data.prediction_date) ? `Model dated ${date(data.prediction_date)}. ` : ''}Model estimate; not a formal appraisal.</p>
  </article>;
}

function Rental({ source, asking, onAskingChange }: { source: SavedData; asking: string; onAskingChange: (value: string) => void }) {
  const data = record(source.data), rent = number(data.price);
  const entered = asking.trim() ? Number(asking) : null;
  const valid = entered === null || Number.isFinite(entered) && entered >= 0;
  const difference = valid && entered !== null && rent !== null && rent > 0 ? (entered - rent) / rent * 100 : null;
  return <article className="overview-card rental-card"><header><p className="overview-eyebrow">Latest advertised rent</p><h2 className="overview-price">{source.loading ? 'Loading…' : rent === null ? 'Not available' : money(rent)}</h2></header>
    {source.loading ? <Unavailable source={source} /> : <p className="overview-caption">{rent === null ? 'No rental observation returned for this address.' : `Advertised ${date(data.date) ?? 'on an unknown date'}. A past listing, not a current rent estimate. The API does not specify its rent period.`}</p>}
    <div className="asking-rent"><label htmlFor="asking-rent">Compare with the asking rent</label><p id="asking-rent-hint" className="overview-muted">Optional. Enter an amount for the same rent period.</p><div className="rent-input"><span aria-hidden="true">$</span><input id="asking-rent" name="asking-rent" inputMode="decimal" autoComplete="off" placeholder="Enter listing amount" value={asking} onChange={event => onAskingChange(event.target.value)} aria-describedby={`asking-rent-hint${!valid ? ' asking-rent-error' : ''}`} aria-invalid={!valid || undefined} /><span aria-hidden="true">AUD</span></div>{!valid && <p id="asking-rent-error" className="popup-field-error">Enter an amount of zero or more.</p>}</div>
    {difference !== null && <p className="rent-comparison"><ArrowRightIcon aria-hidden="true" />{Math.abs(difference) < 0.5 ? 'Asking rent matches the last advertised rent.' : `Asking rent is ${Math.round(Math.abs(difference))}% ${difference > 0 ? 'above' : 'below'} the last advertised rent.`}</p>}
    {valid && entered !== null && rent === null && <p className="overview-caption">A comparison needs a saved rental observation for this address.</p>}
  </article>;
}

function ComparableSales({ source }: { source: SavedData }) {
  const [expanded, setExpanded] = useState(false);
  const rows = Array.isArray(source.data) ? source.data.map(record) : [];
  return <SectionCard title="Recent comparable sales" caption="Nearby sales" footer={rows.length > 3 ? <button className="popup-link" onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer sales' : `See all ${rows.length} comparable sales`}<ArrowRightIcon aria-hidden="true" /></button> : undefined}>
    {!rows.length ? <Unavailable source={source} /> : <ul className="overview-list">{rows.slice(0, expanded ? rows.length : 3).map((row, index) => <li className="overview-detail-row" key={index}><div><h3>{text(row.address) ?? text(row.street) ?? 'Address not supplied'}</h3><p className="overview-muted">{[number(row.bedrooms) !== null ? `${row.bedrooms} bed` : null, number(row.dist_km) !== null ? `${row.dist_km} km` : null, date(row.date_sold) ? `Sold ${date(row.date_sold)}` : null].filter(Boolean).join(' · ') || 'Sale details not supplied'}</p></div><strong>{money(row.price)}</strong></li>)}</ul>}
  </SectionCard>;
}

function Planning({ source }: { source: SavedData }) {
  const data = record(source.data);
  return <SectionCard title="Planning & zoning" caption="At this address"><div className="overview-detail-row"><span className="overview-icon"><MapPinIcon aria-hidden="true" /></span><div>{text(data.code) || text(data.name) ? <><h3>{[text(data.code), text(data.name)].filter(Boolean).join(' · ')}</h3><p className="overview-muted">{text(data.category) ?? 'Primary planning zone'}</p></> : <Unavailable source={source} />}</div></div><p className="overview-caption">Nearby development applications are not supplied by this API.</p></SectionCard>;
}

function EnvironmentalRisks({ source }: { source: SavedData }) {
  const data = record(source.data);
  return <SectionCard title="Environmental overlays" caption="Where mapped"><div className="overview-risk-grid">{[{ key: 'flood', title: 'Flooding', icon: WavesIcon }, { key: 'bushfire', title: 'Bushfire', icon: FlameIcon }].map(({ key, title, icon: Icon }) => {
    const records = Array.isArray(data[key]) ? (data[key] as unknown[]).map(record) : null;
    const onProperty = records?.some(item => item.on_property === true);
    const clear = records !== null && (records.length === 0 || records.every(item => item.on_property === false));
    return <div key={key} className="overview-risk"><h3><Icon aria-hidden="true" />{title}</h3><span className="popup-badge" data-tone={onProperty ? 'warning' : 'neutral'}>{source.loading ? 'Loading' : onProperty ? 'Overlay at address' : clear ? 'No overlay at point' : 'Not available'}</span></div>;
  })}</div><p className="overview-caption">Address-point overlays are not a risk rating or a planning certificate.</p></SectionCard>;
}

function Living({ amenities, transport }: { amenities: SavedData; transport: SavedData }) {
  const places = Array.isArray(record(amenities.data).results) ? (record(amenities.data).results as unknown[]).map(record) : [];
  const stops = Object.values(record(record(transport.data).nearest)).map(record).filter(item => number(item.distance_m) !== null && (item.distance_m as number) >= 0).sort((a, b) => (a.distance_m as number) - (b.distance_m as number));
  function nearest(pattern: RegExp) { return places.filter(item => pattern.test(String(item.category))).sort((a, b) => (number(a.distance_m) ?? Infinity) - (number(b.distance_m) ?? Infinity))[0]; }
  // The distance is shown once: in the badge when the place has a name, otherwise as the only detail.
  const placeName = (value: Record<string, unknown>) => text(value.name) ?? text(value.label) ?? text(value.category);
  const rows = [
    { title: 'Public transport', icon: TrainFrontIcon, value: stops[0], loading: transport.loading },
    { title: 'Parks & recreation', icon: TreePineIcon, value: nearest(/park|green|recreation|pool/i), loading: amenities.loading },
    { title: 'Supermarkets & services', icon: ShoppingCartIcon, value: nearest(/supermarket|grocery|pharmacy/i), loading: amenities.loading },
    { title: 'Healthcare & community', icon: HeartPulseIcon, value: nearest(/health|medical|hospital|clinic|library|community/i), loading: amenities.loading },
    { title: 'Noise exposure', icon: Volume2Icon, value: undefined, loading: false },
    { title: 'Greenery', icon: LeafIcon, value: undefined, loading: false },
  ];
  return <SectionCard title="Everyday living" caption="Straight-line distances"><ul className="overview-list">{rows.map(({ title, icon: Icon, value, loading }) => <li className="overview-living-row" key={title}><span className="overview-icon"><Icon aria-hidden="true" /></span><div><h3>{title}</h3><p className="overview-muted">{loading ? 'Loading saved data…' : value ? placeName(value) ?? distance(value.distance_m) ?? 'Distance not supplied' : 'Not available in the returned data'}</p></div>{value && placeName(value) && distance(value.distance_m) && <span className="popup-badge">{distance(value.distance_m)}</span>}</li>)}</ul></SectionCard>;
}

function Wellbeing({ source }: { source: SavedData }) {
  const index = calculateWellbeing(source.data);
  return <article className="overview-wellbeing" aria-busy={source.loading || undefined}><div className="wellbeing-intro"><div className="wellbeing-ring" data-unavailable={index.value === null} style={{ '--score': index.value ?? 0 } as CSSProperties} aria-hidden="true"><span>{source.loading ? '…' : index.value ?? '—'}</span></div><div><h2>Neighbourhood wellbeing</h2><p className="overview-muted">{source.loading ? 'Calculating from saved data…' : index.value !== null ? `${index.value} / 100 · Calculated suburb index` : 'Not enough data to calculate a score'}</p>{index.area && <p className="overview-caption">{index.area} · {index.available} of {index.total} indicators</p>}</div></div>
    {index.value !== null && <meter className="popup-sr-only" min={0} max={100} value={index.value} aria-label="Neighbourhood wellbeing" aria-valuetext={`${index.value} out of 100; ${index.available} of ${index.total} indicators; ${index.area}`} />}
    <details className="wellbeing-details"><summary>View five indicators <ArrowRightIcon aria-hidden="true" /></summary><div className="wellbeing-breakdown"><p className="overview-muted">Equal-weight average of available lifestyle, convenience, family, safety and tranquility scores for this suburb. At least three of five are required. This prototype index describes suburb context.</p><dl>{index.scores.map(row => <div key={row.key}><dt>{row.label}</dt><dd>{row.value === null ? 'Not available' : `${row.value} / 100`}</dd></div>)}</dl><p className="overview-caption">Source: saved Microburbs suburb livability data. Missing indicators are excluded, and the average is rounded once.</p></div></details>
  </article>;
}

export function PropertyOverview({ report, onSave }: { report: ReportSnapshot; onSave?: (candidate: Candidate) => Promise<void> }) {
  const valuation = useReportData(report, '/valuation/avm');
  const rent = useReportData(report, '/rent-history-latest');
  const sale = useReportData(report, '/sale-history-latest');
  const comparables = useReportData(report, '/comparables/recent-sales-nearby');
  const planning = useReportData(report, '/development/zoning-code');
  const amenities = useReportData(report, '/amenities/nearby');
  const transport = useReportData(report, '/transport/nearby');
  const risks = useReportData(report, '/risks/all');
  const livability = useReportData(report, '/lifestyle/livability', 'suburbs');
  const [asking, setAsking] = useState('');
  const [mode, setMode] = useState('rental');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [status, setStatus] = useState('');
  const [changeHelp, setChangeHelp] = useState(false);
  const tabsId = useId();
  async function save() {
    if (!onSave || savingRef.current) return;
    savingRef.current = true; setSaving(true); setStatus('');
    try { await onSave(report.candidate); setStatus('Address saved to your notes.'); }
    catch { setStatus('Could not save the address. Please try again.'); }
    finally { savingRef.current = false; setSaving(false); }
  }
  async function share() {
    try { await navigator.clipboard.writeText(report.candidate.label); setStatus('Address copied. Paste it into a message to share this home.'); }
    catch { setStatus('Could not copy the address. Select and copy the address above.'); }
  }
  return <div className="overview-stack">
    <article className="overview-card address-card"><span className="overview-icon"><MapPinIcon aria-hidden="true" /></span><div><p className="overview-confirmed"><CheckIcon aria-hidden="true" />Confirmed address</p><h1>{report.candidate.label}</h1></div><button className="popup-link" onClick={() => setChangeHelp(value => !value)} aria-expanded={changeHelp} aria-controls={`${tabsId}-address-help`}>Change</button>{changeHelp && <p id={`${tabsId}-address-help`} className="overview-muted">Select another address on a webpage, choose Look up property, and confirm the match. Then reopen this popup.</p>}</article>
    <div className="research-tabs" role="tablist" aria-label="Property research" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const value = event.key === 'Home' ? 'rental' : event.key === 'End' ? 'buy' : mode === 'rental' ? 'buy' : 'rental';
      setMode(value); event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${value}"]`)?.focus();
    }}>{[{ value: 'rental', label: 'Rental', icon: KeyRoundIcon }, { value: 'buy', label: 'Buy', icon: HouseIcon }].map(({ value, label, icon: Icon }) => <button key={value} type="button" role="tab" id={`${tabsId}-${value}-tab`} data-mode={value} aria-selected={mode === value} aria-controls={`${tabsId}-${value}`} tabIndex={mode === value ? 0 : -1} onClick={() => setMode(value)}><Icon aria-hidden="true" />{label}</button>)}</div>
    <div id={`${tabsId}-rental`} role="tabpanel" aria-labelledby={`${tabsId}-rental-tab`} hidden={mode !== 'rental'} className="overview-stack"><Rental source={rent} asking={asking} onAskingChange={setAsking} /><Living amenities={amenities} transport={transport} /></div>
    <div id={`${tabsId}-buy`} role="tabpanel" aria-labelledby={`${tabsId}-buy-tab`} hidden={mode !== 'buy'} className="overview-stack"><Valuation source={valuation} sale={sale} /><ComparableSales source={comparables} /><Planning source={planning} /><EnvironmentalRisks source={risks} /></div>
    <Wellbeing source={livability} />
    <div className="overview-primary-actions">{onSave && <button className="popup-button primary" disabled={saving} onClick={() => void save()}><BookmarkIcon aria-hidden="true" />{saving ? 'Saving…' : 'Save to notes'}</button>}<button className="popup-button" onClick={() => void share()}><Share2Icon aria-hidden="true" />Share this home</button></div>
    <p className="status" role="status" aria-atomic="true">{status}</p>
  </div>;
}
