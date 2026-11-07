import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRightIcon, BookmarkIcon, CheckIcon, FlameIcon, HeartPulseIcon, HouseIcon, KeyRoundIcon, LeafIcon, MapPinIcon, Share2Icon, ShoppingCartIcon, TrainFrontIcon, TreePineIcon, Volume2Icon, WavesIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import type { ReportSnapshot } from '@/property-report';
import type { Candidate } from '@/types';

type RecordData = Record<string, unknown>;
const record = (value: unknown): RecordData => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : {};
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const money = (value: unknown) => number(value) === null ? 'Not available' : new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(value as number);
const distance = (value: unknown) => number(value) === null ? null : (value as number) < 1000 ? `${Math.round(value as number)} m` : `${((value as number) / 1000).toFixed(1)} km`;
function date(value: unknown) {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Read only saved report envelopes. This view never starts a separate API lookup.
function useReportData(report: ReportSnapshot, suffix: string) {
  const task = report.tasks.find(item => item.endpoint.startsWith('/v1/properties/') && item.endpoint.endsWith(suffix));
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
  const loading = task?.status === 'pending' || task?.status === 'loading' || task?.status === 'ok' && !current;
  return { data: current?.data, loading, failed: task?.status === 'error' || !!current?.error };
}
type SavedData = ReturnType<typeof useReportData>;
function Unavailable({ source }: { source: SavedData }) {
  return source.loading ? <Skeleton className="h-12 w-full" aria-label="Loading saved property data" /> : <p className="overview-muted">{source.failed ? 'Could not load this data. Retry it in the full report below.' : 'No data returned for this address.'}</p>;
}
function SectionCard({ title, caption, children, footer }: { title: string; caption?: string; children: ReactNode; footer?: ReactNode }) {
  return <Card><CardHeader><div className="overview-section-heading"><CardTitle><h2>{title}</h2></CardTitle>{caption && <span className="overview-caption">{caption}</span>}</div></CardHeader><CardContent>{children}</CardContent>{footer && <CardFooter>{footer}</CardFooter>}</Card>;
}

function Valuation({ source, sale }: { source: SavedData; sale: SavedData }) {
  const data = record(source.data), last = record(sale.data);
  const price = number(data.predicted_price), low = number(data.predicted_price_low), high = number(data.predicted_price_high), confidence = number(data.confidence_score);
  return <Card><CardHeader><CardDescription><span className="overview-eyebrow">Estimated property value</span></CardDescription><CardTitle><h2 className="overview-price">{source.loading ? 'Loading…' : price === null ? 'Not available' : money(price)}</h2></CardTitle></CardHeader><CardContent className="flex flex-col gap-4">
    {source.loading ? <Unavailable source={source} /> : price !== null ? <>
      {low !== null && high !== null && <div className="valuation-interval"><div className="valuation-range" aria-hidden="true"><span /></div><div className="range-labels"><span>Low <strong>{money(low)}</strong></span><span>80% range</span><span>High <strong>{money(high)}</strong></span></div></div>}
      <div className="overview-confidence"><span>Model confidence</span><strong>{confidence !== null && confidence >= 0 && confidence <= 100 ? `${confidence} / 100` : 'Not available'}</strong></div>
      <p className="overview-caption">{date(data.prediction_date) ? `Model dated ${date(data.prediction_date)}. ` : ''}An estimate, not a formal appraisal.</p>
    </> : <Unavailable source={source} />}
    <Separator /><div className="overview-detail-row"><div><h3>{text(last.type)?.toLowerCase() === 'sold' ? 'Last sale' : 'Latest sale listing'}</h3><p className="overview-muted">{[text(last.type), date(last.date)].filter(Boolean).join(' · ') || 'No sale record returned'}</p></div><strong>{money(last.price)}</strong></div>
  </CardContent></Card>;
}

function Rental({ source, asking, onAskingChange }: { source: SavedData; asking: string; onAskingChange: (value: string) => void }) {
  const data = record(source.data), rent = number(data.price);
  const entered = asking.trim() ? Number(asking) : null;
  const valid = entered === null || Number.isFinite(entered) && entered >= 0;
  const difference = valid && entered !== null && rent !== null && rent > 0 ? (entered - rent) / rent * 100 : null;
  return <Card><CardHeader><CardDescription><span className="overview-eyebrow">Latest advertised weekly rent</span></CardDescription><CardTitle><h2 className="overview-price">{source.loading ? 'Loading…' : rent === null ? 'Not available' : <>{money(rent)}<span>/wk</span></>}</h2></CardTitle></CardHeader><CardContent className="flex flex-col gap-4">
    {source.loading ? <Unavailable source={source} /> : <p className="overview-muted">{rent === null ? 'No rental observation returned for this address.' : `Advertised ${date(data.date) ?? 'on an unknown date'}. This is a past listing, not a current rent estimate.`}</p>}
    <Separator /><FieldGroup><Field data-invalid={!valid || undefined}><FieldLabel htmlFor="asking-rent">Compare with the asking rent</FieldLabel><FieldDescription id="asking-rent-hint">Optional. Enter the weekly rent from the listing.</FieldDescription><InputGroup><InputGroupAddon><InputGroupText>$</InputGroupText></InputGroupAddon><InputGroupInput id="asking-rent" name="asking-rent" inputMode="decimal" autoComplete="off" placeholder="Enter asking rent" value={asking} onChange={event => onAskingChange(event.target.value)} aria-describedby={`asking-rent-hint${!valid ? ' asking-rent-error' : ''}`} aria-invalid={!valid || undefined} /><InputGroupAddon align="inline-end"><InputGroupText>/wk</InputGroupText></InputGroupAddon></InputGroup>{!valid && <FieldDescription id="asking-rent-error">Enter a weekly amount of zero or more.</FieldDescription>}</Field></FieldGroup>
    {difference !== null && <p className="rent-comparison"><ArrowRightIcon className="size-4" aria-hidden="true" />{Math.abs(difference) < 0.5 ? 'Asking rent matches the last advertised rent.' : `Asking rent is ${Math.round(Math.abs(difference))}% ${difference > 0 ? 'above' : 'below'} the last advertised rent.`}</p>}
    {valid && entered !== null && rent === null && <p className="overview-caption">A comparison needs a saved rental observation for this address.</p>}
  </CardContent></Card>;
}

function ComparableSales({ source }: { source: SavedData }) {
  const [expanded, setExpanded] = useState(false);
  const rows = Array.isArray(source.data) ? source.data.map(record) : [];
  return <SectionCard title="Recent comparable sales" caption="Nearby sales" footer={rows.length > 3 ? <Button variant="link" onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer sales' : `See all ${rows.length} comparable sales`}<ArrowRightIcon data-icon="inline-end" aria-hidden="true" /></Button> : undefined}>
    {!rows.length ? <Unavailable source={source} /> : <ul className="overview-list">{rows.slice(0, expanded ? rows.length : 3).map((row, index) => <li className="overview-detail-row" key={index}><div><h3>{text(row.address) ?? text(row.street) ?? 'Address not supplied'}</h3><p className="overview-muted">{[number(row.bedrooms) !== null ? `${row.bedrooms} bed` : null, number(row.dist_km) !== null ? `${row.dist_km} km` : null, date(row.date_sold) ? `Sold ${date(row.date_sold)}` : null].filter(Boolean).join(' · ') || 'Sale details not supplied'}</p></div><strong>{money(row.price)}</strong></li>)}</ul>}
  </SectionCard>;
}

function Planning({ source }: { source: SavedData }) {
  const data = record(source.data);
  return <SectionCard title="Planning & zoning" caption="At this address"><div className="overview-detail-row"><span className="overview-icon"><MapPinIcon aria-hidden="true" /></span><div className="flex-1">{text(data.code) || text(data.name) ? <><h3>{[text(data.code), text(data.name)].filter(Boolean).join(' · ')}</h3><p className="overview-muted">{text(data.category) ?? 'Primary planning zone'}</p></> : <Unavailable source={source} />}</div></div><p className="overview-caption mt-3">Nearby development applications are not supplied by this API.</p></SectionCard>;
}

function EnvironmentalRisks({ source }: { source: SavedData }) {
  const data = record(source.data);
  return <SectionCard title="Environmental overlays" caption="Where mapped"><div className="overview-risk-grid">{[{ key: 'flood', title: 'Flooding', icon: WavesIcon }, { key: 'bushfire', title: 'Bushfire', icon: FlameIcon }].map(({ key, title, icon: Icon }) => {
    const records = Array.isArray(data[key]) ? (data[key] as unknown[]).map(record) : null;
    const onProperty = records?.some(item => item.on_property === true);
    const clear = records !== null && (records.length === 0 || records.every(item => item.on_property === false));
    return <div key={key} className="overview-risk"><h3><Icon className="size-4" aria-hidden="true" />{title}</h3><Badge variant={onProperty ? 'destructive' : 'secondary'}>{source.loading ? 'Loading' : onProperty ? 'Overlay at address' : clear ? 'No overlay at point' : 'Not available'}</Badge></div>;
  })}</div><p className="overview-caption mt-3">Address-point overlays are not a risk rating or a planning certificate.</p></SectionCard>;
}

function Living({ amenities, transport }: { amenities: SavedData; transport: SavedData }) {
  const places = Array.isArray(record(amenities.data).results) ? (record(amenities.data).results as unknown[]).map(record) : [];
  const stops = Object.values(record(record(transport.data).nearest)).map(record).filter(item => number(item.distance_m) !== null).sort((a, b) => (a.distance_m as number) - (b.distance_m as number));
  function nearest(pattern: RegExp) { return places.filter(item => pattern.test(String(item.category))).sort((a, b) => (number(a.distance_m) ?? Infinity) - (number(b.distance_m) ?? Infinity))[0]; }
  const rows = [
    { title: 'Public transport', icon: TrainFrontIcon, value: stops[0], loading: transport.loading },
    { title: 'Parks & recreation', icon: TreePineIcon, value: nearest(/park|green|recreation|pool/i), loading: amenities.loading },
    { title: 'Supermarkets & services', icon: ShoppingCartIcon, value: nearest(/supermarket|grocery|pharmacy/i), loading: amenities.loading },
    { title: 'Healthcare & community', icon: HeartPulseIcon, value: nearest(/health|medical|hospital|clinic|library|community/i), loading: amenities.loading },
    { title: 'Noise exposure', icon: Volume2Icon, value: undefined, loading: false },
    { title: 'Street greenery', icon: LeafIcon, value: undefined, loading: false },
  ];
  return <SectionCard title="Everyday living" caption="Distances from this address"><ul className="overview-list">{rows.map(({ title, icon: Icon, value, loading }) => <li className="overview-living-row" key={title}><span className="overview-icon"><Icon aria-hidden="true" /></span><div><h3>{title}</h3><p className="overview-muted">{loading ? 'Loading saved data…' : value ? [text(value.name) ?? text(value.label) ?? text(value.category), distance(value.distance_m)].filter(Boolean).join(' · ') || 'Distance not supplied' : 'Not available in the returned data'}</p></div></li>)}</ul></SectionCard>;
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
  const [asking, setAsking] = useState('');
  const [mode, setMode] = useState('rental');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [changeHelp, setChangeHelp] = useState(false);
  async function save() {
    if (!onSave || saving) return;
    setSaving(true); setStatus('');
    try { await onSave(report.candidate); setStatus('Address saved to your notes.'); }
    catch { setStatus('Could not save the address. Please try again.'); }
    finally { setSaving(false); }
  }
  async function share() {
    try { await navigator.clipboard.writeText(report.candidate.label); setStatus('Address copied. Paste it into a message to share this home.'); }
    catch { setStatus('Could not copy the address. Select and copy the address above.'); }
  }
  return <div className="overview-stack">
    <Card size="sm"><CardHeader><div className="overview-address"><span className="overview-icon"><MapPinIcon aria-hidden="true" /></span><div><CardDescription><span className="overview-confirmed"><CheckIcon className="size-3" aria-hidden="true" />Confirmed address</span></CardDescription><CardTitle><h1>{report.candidate.label}</h1></CardTitle></div><Button variant="link" size="sm" onClick={() => setChangeHelp(value => !value)} aria-expanded={changeHelp} aria-controls="change-address-help">Change</Button></div>{changeHelp && <CardDescription id="change-address-help">Select another address on a webpage, choose Look up property, and confirm the match. Then reopen this popup.</CardDescription>}</CardHeader></Card>
    <Tabs value={mode} onValueChange={setMode} className="gap-3"><TabsList className="w-full min-h-12" aria-label="Property research"><TabsTrigger value="rental"><KeyRoundIcon aria-hidden="true" />Rental</TabsTrigger><TabsTrigger value="buy"><HouseIcon aria-hidden="true" />Buy</TabsTrigger></TabsList>
      <TabsContent value="rental" forceMount hidden={mode !== 'rental'} className="overview-stack"><Rental source={rent} asking={asking} onAskingChange={setAsking} /><Living amenities={amenities} transport={transport} /></TabsContent>
      <TabsContent value="buy" className="overview-stack"><Valuation source={valuation} sale={sale} /><ComparableSales source={comparables} /><Planning source={planning} /><EnvironmentalRisks source={risks} /></TabsContent>
    </Tabs>
    <Collapsible className="overview-wellbeing"><div className="overview-wellbeing-header"><span className="overview-icon"><HeartPulseIcon aria-hidden="true" /></span><div><h2>Neighbourhood wellbeing</h2><p className="overview-muted">A score is not available from this API.</p><CollapsibleTrigger asChild><Button variant="link" size="sm">About the six indicators<ArrowRightIcon data-icon="inline-end" aria-hidden="true" /></Button></CollapsibleTrigger></div></div><CollapsibleContent><p className="overview-muted mt-3">Transport, recreation, local services, healthcare, noise and greenery can help you understand an area. Available distances appear under Rental. We do not turn missing data into a score.</p></CollapsibleContent></Collapsible>
    <div className="overview-primary-actions">{onSave && <Button disabled={saving} onClick={() => void save()}>{saving ? <Spinner data-icon="inline-start" /> : <BookmarkIcon data-icon="inline-start" aria-hidden="true" />}Save to notes</Button>}<Button variant="outline" onClick={() => void share()}><Share2Icon data-icon="inline-start" aria-hidden="true" />Share this home</Button></div>
    <p className="status" role="status" aria-atomic="true">{status}</p>
    <Card size="sm"><CardHeader><div className="overview-detail-row"><div><CardDescription><span className="overview-eyebrow">More local knowledge</span></CardDescription><CardTitle><h2>Suburb insights & market updates</h2></CardTitle></div><Button asChild variant="outline" size="icon" aria-label="Explore Microburbs"><a href="https://www.microburbs.com.au" target="_blank" rel="noreferrer"><ArrowRightIcon aria-hidden="true" /></a></Button></div></CardHeader></Card>
  </div>;
}
