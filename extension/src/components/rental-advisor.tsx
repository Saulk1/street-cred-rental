import { InfoIcon, TriangleAlertIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace';
import type { RentalCommand, RentalRecommendation, RentalReply } from '../../../shared/rental';

const aud = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const money = (value: number | null) => value === null ? 'Unavailable' : aud.format(value);
const metres = (value: number) => `${Math.round(value)} m`;
const percent = (value: number) => `${Math.min(100, Math.max(0, value))}%`;

/** How far the asking rent sits from the estimated fair asking rent. The scale stops at 30% either way. */
const GAUGE_SPAN = 30;
/** Every home's station walk is drawn on the same scale so the cards can be compared by eye. */
const WALK_SCALE_M = 1500;
/** Requirements a renter may need to confirm with the agent; other unknown features are not shown. */
const CONFIRM_LABELS: Record<string, string> = { pets: 'Pet policy', furnished: 'Furnishings', parking: 'Parking' };

function fairRentCaption(rent: number, fair: number) {
  const difference = Math.round(rent - fair);
  if (Math.abs(difference) / fair < 0.01) return `In line with the estimated fair asking rent of ${money(fair)}`;
  return `${money(Math.abs(difference))} ${difference < 0 ? 'below' : 'above'} the estimated fair asking rent of ${money(fair)}`;
}

function RentGauge({ rent, fair }: { rent: number; fair: number | null }) {
  if (fair === null || fair <= 0) return <p className="text-muted-foreground">No fair asking rent estimate for this home.</p>;
  const gap = (rent / fair - 1) * 100;
  const position = 50 + Math.max(-GAUGE_SPAN, Math.min(GAUGE_SPAN, gap)) / GAUGE_SPAN * 50;
  const caption = fairRentCaption(rent, fair);
  return <div className="flex flex-col gap-1.5">
    <div role="img" aria-label={caption} className="relative h-3">
      <span className="absolute inset-x-0 top-1 h-1 rounded-full bg-muted" />
      <span className="absolute top-1 h-1 rounded-full bg-primary/30" style={{ insetInlineStart: percent(Math.min(50, position)), inlineSize: percent(Math.abs(position - 50)) }} />
      <span className="absolute inset-y-0 start-1/2 w-0.5 -translate-x-1/2 rounded-full bg-foreground/60" />
      <span className="absolute top-0 size-3 -translate-x-1/2 rounded-full bg-primary ring-2 ring-card" style={{ insetInlineStart: percent(position) }} />
    </div>
    <p aria-hidden="true">{caption}</p>
  </div>;
}

function WalkBand({ walk, band }: { walk: number | null; band: (number | null)[] }) {
  if (walk === null) return <p className="text-muted-foreground">Unavailable</p>;
  const [low, high] = [band[0] ?? walk, band[1] ?? walk];
  const scale = (value: number) => value / WALK_SCALE_M * 100;
  const caption = low === high ? `About ${metres(walk)}` : `About ${metres(walk)}, likely ${Math.round(low)}–${metres(high)}`;
  return <div className="flex flex-col gap-1.5">
    <div role="img" aria-label={`Estimated station walk: ${caption}`} className="relative h-3">
      <span className="absolute inset-x-0 top-1 h-1 rounded-full bg-muted" />
      <span className="absolute top-1 h-1 rounded-full bg-primary/30" style={{ insetInlineStart: percent(scale(low)), inlineSize: percent(scale(high) - scale(low)) }} />
      <span className="absolute top-0.5 size-2 -translate-x-1/2 rounded-full bg-primary" style={{ insetInlineStart: percent(scale(walk)) }} />
    </div>
    <p aria-hidden="true">{caption}</p>
  </div>;
}

/** What this home trades against the first recommendation, in the renter's terms. */
function tradeoffs(home: RentalRecommendation, best: RentalRecommendation) {
  const lines: string[] = [];
  const rent = Math.round(home.weeklyRent - best.weeklyRent);
  if (rent) lines.push(`${money(Math.abs(rent))} ${rent < 0 ? 'less' : 'more'} per week than the first home`);
  if (home.stationWalkM !== null && best.stationWalkM !== null) {
    const walk = Math.round((home.stationWalkM - best.stationWalkM) / 10) * 10;
    if (Math.abs(walk) >= 50) lines.push(`${metres(Math.abs(walk))} ${walk < 0 ? 'closer to' : 'further from'} a station`);
  }
  return lines;
}

function HomeCard({ home, best, busy, act }: { home: RentalRecommendation; best: RentalRecommendation; busy: boolean; act: (command: RentalCommand) => void }) {
  const first = home.listing_id === best.listing_id;
  const confirm = home.unknownFeatures.filter(feature => feature in CONFIRM_LABELS);
  const name = home.address || home.listing_id;
  return <Card size="sm" className="row-span-4 grid grid-rows-subgrid" role="group" aria-label={name}>
    <CardHeader>
      <Badge variant={first ? 'default' : 'secondary'}>{home.label}</Badge>
      <CardTitle>{name}</CardTitle>
      {home.district && <CardDescription>{home.district}</CardDescription>}
    </CardHeader>
    <CardContent className="flex flex-col gap-1">
      <p><span className="text-2xl font-semibold tabular-nums">{money(home.weeklyRent)}</span> <span className="text-muted-foreground">per week</span></p>
      {!first && tradeoffs(home, best).map(line => <p key={line} className="text-muted-foreground">{line}</p>)}
    </CardContent>
    <CardContent className="flex flex-col gap-4">
      <dl className="flex flex-col gap-4 text-xs tabular-nums">
        <div className="flex flex-col gap-1.5"><dt className="font-medium">Against fair asking rent</dt><dd><RentGauge rent={home.weeklyRent} fair={home.fairRent} /></dd></div>
        <div className="flex flex-col gap-1.5"><dt className="font-medium">Walk to a station</dt><dd><WalkBand walk={home.stationWalkM} band={home.stationWalkBand} /></dd></div>
        <div className="flex flex-col gap-1.5"><dt className="font-medium">Walk to a supermarket</dt><dd>{home.supermarketWalkMin === null ? <span className="text-muted-foreground">Unavailable</span> : `About ${Math.round(home.supermarketWalkMin)} min`}</dd></div>
        {!!confirm.length && <div className="flex flex-col gap-1.5"><dt className="font-medium">Confirm with the agent</dt>
          <dd className="flex flex-wrap gap-1">{confirm.map(feature => <Badge key={feature} variant="outline">{CONFIRM_LABELS[feature]}</Badge>)}</dd></div>}
      </dl>
      <p className="text-xs text-muted-foreground">{home.reason}</p>
      {home.price_check && <Alert><TriangleAlertIcon /><AlertTitle>Check this price</AlertTitle>
        <AlertDescription>Price needs verification: this may be a room listing or incorrect data.</AlertDescription></Alert>}
    </CardContent>
    <CardFooter className="flex flex-wrap gap-2">
      <Button size="sm" variant={first ? 'default' : 'outline'} disabled={busy} aria-label={`Prefer this home: ${name}`} onClick={() => act({ operation: 'feedback', chosenId: home.listing_id })}>Prefer this home</Button>
      <Button size="sm" variant="ghost" disabled={busy} aria-label={`Reject this home: ${name}`} onClick={() => act({ operation: 'feedback', rejectedIds: [home.listing_id] })}>Reject</Button>
    </CardFooter>
  </Card>;
}

export function RentalAdvisorPanel({ reply, busy, act }: { reply: RentalReply; busy: boolean; act: (command: RentalCommand) => void }) {
  const [option, setOption] = useState('');
  const [custom, setCustom] = useState('');
  const [feedback, setFeedback] = useState('');
  const id = useId();
  const result = reply.result;
  const homes = result.recommendations ?? [];
  const snapshot = new Date(result.provenance.snapshotDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  return <Card aria-label="Rental advisor" aria-busy={busy} className="@container">
    <CardHeader><CardTitle>Rental advisor</CardTitle><CardDescription>Listings as of {snapshot}. Check availability with the agent.</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-5">
      {result.message && <p role="status">{result.message}</p>}
      {result.action === 'ask' && <form onSubmit={event => { event.preventDefault();
        if (custom.trim() || option) act({ operation: 'answer', questionId: result.question_id!, ...(custom.trim() ? { text: custom.trim() } : { optionId: option }) });
      }}><FieldSet disabled={busy}><FieldLegend id={`${id}-question`}>{result.question_text}</FieldLegend><FieldGroup>
        <Field data-disabled={busy}>
          <ToggleGroup type="single" variant="outline" value={option} onValueChange={value => { setOption(value); setCustom(''); }} disabled={busy} aria-labelledby={`${id}-question`} className="flex flex-wrap justify-start gap-2">
            {result.options!.map(o => <ToggleGroupItem key={o.id} value={o.id}>{o.label}</ToggleGroupItem>)}
          </ToggleGroup>
        </Field>
        <Field data-disabled={busy}><FieldLabel htmlFor={`${id}-custom`}>Or give a custom answer</FieldLabel>
          <Input id={`${id}-custom`} name="rentalAnswer" value={custom} maxLength={4000} required={!option} disabled={busy} onChange={e => { setCustom(e.target.value); setOption(''); }} />
        </Field>
        <Field orientation="horizontal"><Button type="submit" disabled={busy}>Apply answer</Button></Field>
      </FieldGroup></FieldSet></form>}
      {result.action === 'no_match' && <Empty><EmptyHeader><EmptyTitle>No rentals match yet</EmptyTitle>
        <EmptyDescription>No rentals in this snapshot match your confirmed requirements. You can change them in the chat.</EmptyDescription></EmptyHeader></Empty>}
      {['needs_data', 'fallback'].includes(result.action) && <Empty><EmptyHeader><EmptyTitle>Not enough data</EmptyTitle>
        <EmptyDescription>More rental data is needed before recommendations can be made.</EmptyDescription></EmptyHeader></Empty>}
      {!!homes.length && <section aria-label="Recommended homes" className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 @2xl:grid-flow-col @2xl:auto-cols-fr @2xl:grid-cols-none @2xl:grid-rows-[auto_auto_1fr_auto]">
          {homes.map(home => <HomeCard key={home.listing_id} home={home} best={homes[0]} busy={busy} act={act} />)}
        </div>
        <p className="text-xs text-muted-foreground">Preferring a home teaches the advisor what matters to you. Rejecting one removes it from this search.</p>
      </section>}
      {!!homes.length && <form onSubmit={event => { event.preventDefault(); if (feedback.trim()) act({ operation: 'feedback', reasons: [feedback.trim()] }); }}>
        <FieldGroup><Field data-disabled={busy}><FieldLabel htmlFor={`${id}-feedback`}>What should we change?</FieldLabel>
          <InputGroup><InputGroupInput id={`${id}-feedback`} name="rentalFeedback" required maxLength={300} value={feedback} placeholder="Too far from the station, too expensive…" onChange={e => setFeedback(e.target.value)} disabled={busy} />
            <InputGroupAddon align="inline-end"><InputGroupButton type="submit" variant="default" disabled={busy}>Update recommendations</InputGroupButton></InputGroupAddon></InputGroup>
          {result.followup && <FieldDescription>{result.followup}</FieldDescription>}
        </Field></FieldGroup>
      </form>}
      {!homes.length && result.followup && <p>{result.followup}</p>}
      <Trace><TraceCollapsible><TraceCollapsibleTrigger><TraceLine><TraceIcon><InfoIcon /></TraceIcon><TraceTitle>Model, sources and limitations</TraceTitle></TraceLine></TraceCollapsibleTrigger><TraceCollapsibleContent><p>Model: {result.provenance.modelVersion}; advisor: {result.provenance.advisorVersion}</p><ul>{result.warnings.map(w => <li key={w}>{w}</li>)}</ul></TraceCollapsibleContent></TraceCollapsible></Trace>
    </CardContent><CardFooter><Button variant="ghost" disabled={busy} onClick={() => act({ operation: 'resume' })}>Resume rental search</Button></CardFooter>
  </Card>;
}
