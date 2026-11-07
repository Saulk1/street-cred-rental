import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MapPinIcon, SearchIcon, ArrowLeftIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import type { Candidate, Sections, LookupError, LookupResponse, Risks } from '@/types';

type LookupState = { phase: 'idle' | 'loading' | 'choices' | 'empty' | 'details' | 'error'; candidates: Candidate[]; candidate?: Candidate; sections?: Sections; error?: LookupError; announcement: string };
import { absent, displayValue as value, money, Rows, Retry } from '@/components/property-feedback';
import { PropertyExtras } from '@/components/property-extras';

function RiskSection({ data }: { data: Risks }) {
  const labels: Record<string, string> = { bushfire: 'Bushfire', flood: 'Flood', historical_flood: 'Historical flood', heritage: 'Heritage', landslide: 'Landslide', erosion: 'Erosion', environment: 'Environment', hv_power_line: 'High-voltage power lines', mobile_black_spot: 'Mobile black spots' };
  return <div className="risk-list">{Object.entries(labels).map(([key, label]) => <section key={key}><h4>{label}</h4>{!data[key] ? <p>{absent}</p> : !data[key]!.length ? <p>No matching records returned within the search radius (1 km).</p> : data[key]!.map((record, index) => {
    const nearby = key === 'hv_power_line' || key === 'mobile_black_spot';
    const relation = nearby ? 'Nearby feature' : record.on_property === true ? "Overlay at the property's address point" : record.on_property === false ? "Not at the property's address point" : 'Containment unknown';
    return <div key={index} className="overlay-record"><Badge variant="outline">{relation}</Badge>{record.nearest_distance_m != null && <p>Nearest {record.nearest_distance_m} m away</p>}</div>;
  })}</section>)}<section><h4>Neighbourhood context: public housing</h4>{!data.public_housing ? <p>{absent}</p> : !data.public_housing.length ? <p>No matching records returned within 1 km.</p> : data.public_housing.map((r, i) => <p key={i}>{r.on_property === true ? 'Containing Census area' : r.on_property === false ? 'Nearby Census area' : 'Census area (location relation unknown)'}: {value(r.value)}{r.value_unit ? ` (${r.value_unit})` : ''}{r.nearest_distance_m == null ? '' : `; ${r.nearest_distance_m} m away`}</p>)}</section><p className="fine-print">Overlays are tested at the address point, not the surveyed parcel boundary. They do not replace a planning certificate.</p></div>;
}
function PropertySections({ sections, retry }: { sections: Sections; retry: () => void }) {
  return <>{(['basics', 'valuation'] as const).map(key => {
    const section = sections[key];
    let content;
    if (section?.status === 'error') content = <Retry error={section.error} retry={retry} />;
    else if (section?.status !== 'ok') content = <p>{absent}</p>;
    else if (key === 'basics' && sections.basics?.status === 'ok') {
      const d = sections.basics.data;
      content = <Rows entries={[["Property type", value(d.dwelling_type)], ['Bedrooms', value(d.bed_count)], ['Bathrooms', value(d.bath_count)], ['Covered parking spaces', value(d.parking_count)], ['Indicative land area', d.land_area_sqm == null ? absent : `${d.land_area_sqm} m²`]]} />;
    } else if (key === 'valuation' && sections.valuation?.status === 'ok') {
      const d = sections.valuation.data;
      content = <><Rows entries={[["Model estimate (AUD)", money(d.predicted_price)], ['80% prediction interval (AUD)', `${money(d.predicted_price_low)} – ${money(d.predicted_price_high)}`], ['Prediction date', value(d.prediction_date)], ['Model confidence', d.confidence_score == null ? absent : `${d.confidence_score}/100`]]} /><p className="fine-print">A model estimate, not a sale price or a formal appraisal.</p></>;
    }
    return <section key={key} className="property-section"><h3>{{ basics: 'Property facts', valuation: 'Automated valuation', risks: 'Overlays and nearby features' }[key]}</h3>{content}</section>;
  })}</>;
}
export function attachPropertyLookup({ host, shadow, selection, isCurrent, reposition }: { host: HTMLElement; shadow: ShadowRoot; selection: { text: string }; isCurrent: () => boolean; reposition: () => void }) {
  const container = document.createElement('div'); container.className = 'lookup-root'; shadow.append(container);
  const root = createRoot(container);
  let disposed = false, revision = 0;
  let state: LookupState = { phase: 'idle', candidates: [], announcement: '' };
  let lookup!: HTMLButtonElement;
  let panel: HTMLElement | null = null;
  function render(focus = false) {
    if (disposed) return;
    flushSync(() => root.render(<>
      <Button ref={node => { if (node) lookup = node; }} variant="default" disabled={state.phase === 'loading'} onClick={() => void search()}><SearchIcon data-icon="inline-start" aria-hidden="true" />Look up property</Button>
      <p role="status" aria-atomic="true" className="status lookup-status">{state.announcement}</p>
      {state.phase !== 'idle' && <section ref={node => { panel = node; }} className="property-results" tabIndex={-1} aria-busy={state.phase === 'loading'}>
        <Separator />
        {state.candidate && <header className="matched-address"><MapPinIcon className="size-5" aria-hidden="true" /><div><h2>{state.candidate.label}</h2><p>GNAF: {state.candidate.id}</p></div></header>}
        {state.phase === 'loading' && <div className="loading-results"><Spinner aria-label="Loading property information" /><Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" /></div>}
        {state.phase === 'choices' && <><h2>Choose the matching address</h2><p className="fine-print">Check the unit number and suburb before continuing.</p><ul className="address-choices">{state.candidates.map(c => <li key={c.id}><Button variant="outline" onClick={() => void details(c)}><MapPinIcon data-icon="inline-start" aria-hidden="true" />{c.label}</Button></li>)}</ul></>}
        {state.phase === 'empty' && <Empty><EmptyHeader><EmptyTitle>No matching addresses</EmptyTitle><EmptyDescription>Select a fuller address, including the suburb. Coverage is limited to the City of Sydney LGA.</EmptyDescription></EmptyHeader></Empty>}
        {state.phase === 'error' && <Retry error={state.error} retry={() => void (state.candidate ? details(state.candidate) : search())} />}
        {state.phase === 'details' && state.sections && <><PropertySections sections={state.sections} retry={() => void details(state.candidate!)} />
          <PropertyExtras key={`${revision}:${state.candidate!.id}`} id={state.candidate!.id} reposition={reposition}
            risks={state.sections.risks?.status === 'error' ? <Retry error={state.sections.risks.error} retry={() => void details(state.candidate!)} />
              : state.sections.risks?.status === 'ok' ? <RiskSection data={state.sections.risks.data} /> : <p>{absent}</p>} /><p className="fine-print">Source: Microburbs Hackathon API. Coverage: City of Sydney LGA.</p></>}
        {state.candidate && state.candidates.length > 1 && state.phase !== 'loading' && <Button variant="outline" onClick={choices}><ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />Choose another match</Button>}
      </section>}
    </>));
    reposition();
    if (focus) panel?.focus({ preventScroll: true });
  }
  async function send(message: object): Promise<LookupResponse> {
    try { return await chrome.runtime.sendMessage(message) ?? { ok: false }; }
    catch { return { ok: false, error: { message: 'Could not contact the extension. Reload the page and retry.' } }; }
  }
  function expand() { host.setAttribute('data-expanded', 'true'); }
  function choices() { revision++; state = { phase: 'choices', candidates: state.candidates, announcement: 'Choose an address to see property information.' }; render(true); }
  async function search() {
    if (disposed || state.phase === 'loading') return;
    const token = ++revision;
    expand(); state = { phase: 'loading', candidates: [], announcement: 'Finding matching addresses…' }; render();
    const response = await send({ type: 'SEARCH_ADDRESS', address: selection.text });
    if (disposed || !isCurrent() || token !== revision) return;
    if (!response.ok || !Array.isArray(response.candidates)) { state = { ...state, phase: 'error', error: response.error, announcement: 'Address lookup failed.' }; render(); return; }
    state = { ...state, candidates: response.candidates };
    if (!response.candidates.length) { state = { ...state, phase: 'empty', announcement: 'No matching addresses.' }; render(true); }
    else if (response.candidates.length === 1) await details(response.candidates[0]);
    else choices();
  }
  async function details(candidate: Candidate) {
    const token = ++revision;
    expand(); state = { phase: 'loading', candidate, candidates: state.candidates, announcement: 'Loading property information…' }; render();
    const response = await send({ type: 'PROPERTY_DETAILS', id: candidate.id });
    if (disposed || !isCurrent() || token !== revision) return;
    state = response.ok && response.sections ? { ...state, phase: 'details', sections: response.sections, announcement: 'Property information loaded. Unavailable sections are marked below.' } : { ...state, phase: 'error', error: response.error, announcement: 'Property lookup failed.' };
    render(true);
  }
  try { render(); } catch (error) { root.unmount(); container.remove(); throw error; }
  return { button: lookup, start: search, dispose() { if (disposed) return; disposed = true; revision++; root.unmount(); container.remove(); } };
}
