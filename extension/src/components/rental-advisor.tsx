import { InfoIcon } from 'lucide-react';
import { Trace, TraceLine, TraceIcon, TraceTitle, TraceCollapsible, TraceCollapsibleTrigger, TraceCollapsibleContent } from '@/components/ui/trace';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { RentalCommand, RentalReply } from '../../../shared/rental';

export function RentalAdvisorPanel({ reply, busy, act }: { reply: RentalReply; busy: boolean; act: (command: RentalCommand) => void }) {
  const [option, setOption] = useState('');
  const [custom, setCustom] = useState('');
  const [feedback, setFeedback] = useState('');
  const id = useId();
  const result = reply.result;
  const money = (v: number | null) => v === null ? 'Unavailable' : new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(v);
  return <Card aria-label="Rental advisor" aria-busy={busy}>
    <CardHeader><CardTitle>Rental advisor</CardTitle><CardDescription>Listing snapshot: {new Date(result.provenance.snapshotDate).toLocaleDateString('en-AU')}. Check availability with the agent.</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-4">
      {result.message && <p role="status">{result.message}</p>}
      {result.action === 'ask' && <form onSubmit={event => { event.preventDefault();
        if (custom.trim() || option) act({ operation: 'answer', questionId: result.question_id!, ...(custom.trim() ? { text: custom.trim() } : { optionId: option }) });
      }}><FieldSet disabled={busy}><FieldLegend id={`${id}-question`} variant="label">{result.question_text}</FieldLegend><FieldGroup><Field data-disabled={busy}>
        <ToggleGroup type="single" variant="outline" value={option} onValueChange={value => { setOption(value); setCustom(''); }} disabled={busy} aria-labelledby={`${id}-question`} className="flex flex-wrap justify-start gap-2">
          {result.options!.map(o => <ToggleGroupItem key={o.id} value={o.id}>{o.label}</ToggleGroupItem>)}
        </ToggleGroup></Field><Field data-disabled={busy}><FieldLabel htmlFor={`${id}-custom`}>Or give a custom answer</FieldLabel>
          <Input id={`${id}-custom`} name="rentalAnswer" value={custom} maxLength={4000} required={!option} disabled={busy} onChange={e => { setCustom(e.target.value); setOption(''); }} />
        </Field><Button type="submit" disabled={busy}>Apply answer</Button></FieldGroup></FieldSet></form>}
      {result.action === 'no_match' && <p>No rentals in this snapshot match your confirmed requirements. You can change them in the chat.</p>}
      {['needs_data', 'fallback'].includes(result.action) && <p>More rental data is needed before recommendations can be made.</p>}
      {result.recommendations?.map(home => <Card key={home.listing_id} size="sm">
        <CardHeader><CardTitle>{home.address || home.listing_id}</CardTitle><CardDescription>{home.district} · {home.label}</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-2"><p>{money(home.weeklyRent)}/week · Estimated fair asking rent {money(home.fairRent)}/week</p>
          <p>{home.reason}</p><p>Estimated station walk: {home.stationWalkM === null ? 'Unavailable' : `${Math.round(home.stationWalkM)} m (${home.stationWalkBand.map(v => v === null ? '?' : Math.round(v)).join('–')} m)`}</p>
          {home.price_check && <p>Price needs verification: this may be a room listing or incorrect data.</p>}
        </CardContent><CardFooter className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => act({ operation: 'feedback', chosenId: home.listing_id })}>Prefer this home</Button>
          <Button variant="ghost" disabled={busy} onClick={() => act({ operation: 'feedback', rejectedIds: [home.listing_id] })}>Reject this home</Button></CardFooter>
      </Card>)}
      {result.followup && <p>{result.followup}</p>}
      {!!result.recommendations?.length && <form onSubmit={event => { event.preventDefault(); if (feedback.trim()) act({ operation: 'feedback', reasons: [feedback.trim()] }); }}>
        <FieldGroup><Field><FieldLabel htmlFor="rental-feedback">What should we change?</FieldLabel><Input id="rental-feedback" name="rentalFeedback" required maxLength={300} value={feedback} onChange={e => setFeedback(e.target.value)} disabled={busy} /></Field>
          <Button variant="outline" type="submit" disabled={busy}>Update recommendations</Button></FieldGroup>
      </form>}
      <Trace><TraceCollapsible><TraceCollapsibleTrigger><TraceLine><TraceIcon><InfoIcon /></TraceIcon><TraceTitle>Model, sources and limitations</TraceTitle></TraceLine></TraceCollapsibleTrigger><TraceCollapsibleContent><p>Model: {result.provenance.modelVersion}; advisor: {result.provenance.advisorVersion}</p><ul>{result.warnings.map(w => <li key={w}>{w}</li>)}</ul></TraceCollapsibleContent></TraceCollapsible></Trace>
    </CardContent><CardFooter><Button variant="ghost" disabled={busy} onClick={() => act({ operation: 'resume' })}>Resume rental search</Button></CardFooter>
  </Card>;
}
