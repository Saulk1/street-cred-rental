import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { ResourceContent, Rows, absent, displayValue, money, distance, type Resource } from '@/components/property-feedback';
import type { ExtraData, ExtraKey, ExtraResponse, MarketResponse, MarketRecord, MarketPart, Planning, School, Amenities, Transport, TransportMode } from '@/types';

function monthYear(input: string | null) {
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return absent;
  const [year, month, day] = input.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return absent;
  return new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}
function MarketObservation({ record, rent }: { record: MarketRecord; rent: boolean }) {
  return <Rows entries={[
    ['Event', displayValue(record.type)], ['Observation date', monthYear(record.date)],
    [rent ? 'Advertised rent (AUD)' : record.type === 'Sold' ? 'Recorded sale price (AUD)' : 'Advertised price (AUD)', money(record.price)],
    ['Address', displayValue(record.address)],
  ]} />;
}
function PlanningView({ data }: { data: Planning }) {
  return <div className="extra-stack"><Rows entries={[
    ['Zone code', displayValue(data.zoning_code?.code)], ['Zone name', displayValue(data.zoning_code?.name)],
    ['Category', displayValue(data.zoning_code?.category)],
  ]} /><h4>Planning overlays</h4>
    {data.zoning_overlays === null ? <p>{absent}</p> : !data.zoning_overlays.length ? <p>No planning overlays returned.</p> :
      <ul className="extra-list">{data.zoning_overlays.map((row, i) => <li key={i}><strong>{({ fsr: 'Floor space ratio', hob: 'Height of building' } as Record<string, string>)[row.layer ?? ''] ?? row.layer ?? 'Unknown overlay'}</strong><span>{displayValue(row.value)}</span></li>)}</ul>}
    <p className="fine-print">Published zoning and overlay context; this does not establish development approval or replace a planning certificate. Multiple returned overlay values are shown separately.</p>
  </div>;
}
function SchoolView({ data }: { data: School[] }) {
  const [limit, setLimit] = useState(5);
  if (!data.length) return <Empty><EmptyHeader><EmptyTitle>No nearby schools returned</EmptyTitle></EmptyHeader></Empty>;
  return <div className="extra-stack"><p className="fine-print">Showing {Math.min(limit, data.length)} of {data.length} returned schools within approximately 5 km. Distances are straight-line. Nearby schools do not establish catchment eligibility.</p>
    <ul className="extra-list">{data.slice(0, limit).map((school, index) => <li key={`${school.id}-${index}`}><strong>{school.name ?? 'Unnamed school'}</strong><p>{displayValue(school.school_level_type)} · {displayValue(school.sector)} · {distance(school.distance_m)}</p></li>)}</ul>
    {data.length > limit && <Button variant="outline" onClick={() => setLimit(data.length)}>Show more schools</Button>}
  </div>;
}
function AmenitiesView({ data }: { data: Amenities }) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const categories = [
    { category: 'Supermarket', label: 'Supermarkets', key: 'supermarket' },
    { category: 'Green Spaces', label: 'Green spaces', key: 'green_spaces' },
    { category: 'Restaurant', label: 'Restaurants and cafés', key: 'restaurant' },
    ...[...new Set(data.results.map(row => row.category))].filter(name => !['Supermarket', 'Green Spaces', 'Restaurant'].includes(name ?? '')).map(name => ({ category: name, label: name ?? 'Other amenities', key: name ?? '' })),
  ];
  return <div className="extra-stack"><p className="fine-print">Search radius: {distance(data.radius_m)}. Distances are straight-line. Totals are API counts before its 80-result cap.</p>
    {categories.map(({ category, label, key }) => {
      const rows = data.results.filter(row => row.category === category);
      const limit = expanded.includes(key) ? rows.length : 5;
      return <section key={key} className="extra-stack"><h4>{label} <Badge variant="secondary">Total: {displayValue(data.counts[key])}</Badge></h4>
        <p className="fine-print">Showing {Math.min(limit, rows.length)} of {rows.length} returned results.</p>
        {!rows.length ? <p>No results returned in this category.</p> : <ul className="extra-list">{rows.slice(0, limit).map((row, i) => <li key={i}><strong>{row.name ?? 'Unnamed amenity'}</strong><span>{distance(row.distance_m)}</span></li>)}</ul>}
        {rows.length > limit && <Button variant="outline" onClick={() => setExpanded(current => [...current, key])}>Show more {label.toLowerCase()}</Button>}
      </section>;
    })}
  </div>;
}
function TransportView({ data }: { data: Transport }) {
  const modes: [TransportMode, string][] = [['train', 'Train'], ['tram', 'Tram'], ['bus', 'Bus'], ['ferry', 'Ferry']];
  return <div className="extra-stack"><p className="fine-print">Search radius: {distance(data.radius_m)}. Distances are straight-line, not walking routes.</p>
    <ul className="extra-list">{modes.map(([key, label]) => {
      const stop = data.nearest[key];
      return <li key={key}><h4>{label} <Badge variant="secondary">Stops: {displayValue(data.counts[key])}</Badge></h4>
        {stop ? <p>{stop.name ?? stop.label ?? `${label} stop`} · {distance(stop.distance_m)}</p> : <p>{data.counts[key] === 0 ? 'No stops within the search radius.' : 'Nearest stop not available.'}</p>}
      </li>;
    })}</ul>
  </div>;
}

type Resources = { [K in keyof ExtraData]: Resource<ExtraData[K]> } & { market: Record<MarketPart, Resource<MarketRecord>> };
const initialResources = (): Resources => ({ market: { sale: { status: 'idle' }, rent: { status: 'idle' } }, planning: { status: 'idle' }, schools: { status: 'idle' }, amenities: { status: 'idle' }, transport: { status: 'idle' } });
const titles: Record<ExtraKey, string> = { market: 'Latest market activity', planning: 'Zoning and planning', schools: 'Nearby schools', amenities: 'Nearby amenities', transport: 'Nearby transport' };

export function PropertyExtras({ id, risks, reposition }: { id: string; risks: React.ReactNode; reposition: () => void }) {
  const [open, setOpen] = useState<string[]>([]);
  const [resources, setResources] = useState(initialResources);
  const current = useRef(resources);
  const active = useRef(true);
  const pending = useRef(new Set<string>());
  const canFind = 'onbeforematch' in HTMLElement.prototype;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useLayoutEffect(reposition, [open, resources, reposition]);
  function update(next: Resources) { current.current = next; setResources(next); }
  async function load(key: ExtraKey, part?: MarketPart) {
    const token = key + (part ?? '');
    if (pending.current.has(token)) return;
    if (key === 'market' && (pending.current.has('market') || (!part && (pending.current.has('marketsale') || pending.current.has('marketrent'))))) return;
    pending.current.add(token);
    if (key === 'market') {
      const market = { ...current.current.market };
      for (const name of part ? [part] : ['sale', 'rent'] as const) market[name] = { status: 'loading' };
      update({ ...current.current, market });
    } else update({ ...current.current, [key]: { status: 'loading' } });
    let response: ExtraResponse<ExtraData[keyof ExtraData]> | MarketResponse;
    try { response = await chrome.runtime.sendMessage({ type: 'PROPERTY_SECTION', id, section: key, ...(part ? { part } : {}) }) ?? { ok: false }; }
    catch { response = { ok: false, error: { message: 'Could not contact the extension. Reload the page and retry.' } }; }
    pending.current.delete(token);
    if (!active.current) return;
    const error = { status: 'error' as const, error: !response.ok ? response.error ?? { message: 'Could not load this section. Please retry.' } : { message: 'Microburbs returned an unexpected response. Please retry.' } };
    if (key === 'market') {
      const market = { ...current.current.market };
      for (const name of part ? [part] : ['sale', 'rent'] as const) market[name] = response.ok && 'market' in response ? response.market[name] ?? error : error;
      update({ ...current.current, market });
    } else update({ ...current.current, [key]: response.ok && 'section' in response ? response.section : error });
  }
  function change(next: string[]) {
    setOpen(next);
    for (const key of next) {
      if (key === 'risks') continue;
      const name = key as ExtraKey;
      if (name === 'market' ? current.current.market.sale.status === 'idle' : current.current[name].status === 'idle') void load(name);
    }
  }
  function content(key: ExtraKey) {
    if (key === 'market') return <div className="extra-stack">{(['sale', 'rent'] as const).map(part => <section key={part} className="extra-stack"><h4>{part === 'sale' ? 'Latest sale/listing observation' : 'Latest rental listing observation'}</h4><ResourceContent resource={resources.market[part]} retry={() => void load('market', part)}>{record => <MarketObservation record={record} rent={part === 'rent'} />}</ResourceContent></section>)}<p className="fine-print">Listing-feed observations, not a complete title or transfer register. Dates are shown to the month. Advertised rent has no normalized period; do not assume a weekly amount.</p></div>;
    if (key === 'planning') return <ResourceContent resource={resources.planning} retry={() => void load(key)}>{data => <PlanningView data={data} />}</ResourceContent>;
    if (key === 'schools') return <ResourceContent resource={resources.schools} retry={() => void load(key)}>{data => <SchoolView data={data} />}</ResourceContent>;
    if (key === 'amenities') return <ResourceContent resource={resources.amenities} retry={() => void load(key)}>{data => <AmenitiesView data={data} />}</ResourceContent>;
    return <ResourceContent resource={resources.transport} retry={() => void load(key)}>{data => <TransportView data={data} />}</ResourceContent>;
  }
  return <Accordion type="multiple" value={open} onValueChange={change} className="property-extras">
    {(['risks', ...Object.keys(titles)] as const).map(key => {
      const loaded = key === 'risks' || (key === 'market' ? resources.market.sale.status !== 'idle' : resources[key as keyof ExtraData].status !== 'idle');
      const expanded = open.includes(key);
      // React treats hidden as a boolean, so set until-found through the DOM.
      // Chrome 116 supports it; keep loaded content mounted for native Find.
      return <AccordionItem key={key} value={key}>
        <AccordionTrigger>{key === 'risks' ? 'Overlays and nearby features' : titles[key as ExtraKey]}</AccordionTrigger>
        <AccordionContent forceMount hidden={false} className="p-0">
          <div hidden={!expanded} ref={node => {
            if (!node) return;
            if (!expanded && canFind && loaded) node.setAttribute('hidden', 'until-found');
            const reveal = () => { if (!expanded) flushSync(() => change([...open, key])); };
            node.addEventListener('beforematch', reveal);
            return () => node.removeEventListener('beforematch', reveal);
          }}>
            <div className="extra-content">{key === 'risks' ? risks : loaded ? content(key as ExtraKey) : null}</div>
          </div>
        </AccordionContent>
      </AccordionItem>;
    })}
  </Accordion>;
}
