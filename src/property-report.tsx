import { useEffect, useMemo, useRef, useState } from 'react';
import { MapPinIcon, RefreshCwIcon, DownloadIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Table, TableCaption, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Rows, Retry } from '@/components/property-feedback';
import { PropertySections, RiskSection } from '@/property-lookup';
import { PropertyOverview } from '@/property-overview';
import type { Candidate, LookupError, Basics, Valuation, Risks } from '@/types';

export type ReportTask = {
  id: string; endpoint: string; title: string; group: string;
  status: 'pending' | 'loading' | 'ok' | 'empty' | 'unavailable' | 'error' | 'skipped';
  error?: LookupError; reason?: string; notice?: string; savedAt?: number; documentation?: string;
};
export type ReportSnapshot = {
  id: string; candidate: Candidate; state: 'running' | 'paused' | 'complete';
  selectedAt: number; updatedAt: number; total: number; completed: number; errors: number; error?: string;
  tasks: ReportTask[]; supporting: { endpoint: string; reason: string }[];
};
type Envelope = { data: unknown; available?: boolean; reason?: string; message?: string; [key: string]: unknown };
type Reply = { ok: boolean; report?: ReportSnapshot | null; result?: Envelope | null; error?: LookupError; documentation?: string };
const label = (key: string) => key.replaceAll('_', ' ').replace(/\b\w/, c => c.toUpperCase());
const scalar = (value: unknown) => value === null || value === undefined ? 'Not available' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value);
async function send(message: object): Promise<Reply> {
  try { return await chrome.runtime.sendMessage(message) ?? { ok: false }; }
  catch { return { ok: false }; }
}

function PageButtons({ page, count, change, unit = 'rows' }: { page: number; count: number; change: (page: number) => void; unit?: string }) {
  return <div className="report-actions">
    <Button variant="outline" size="sm" disabled={page === 0} onClick={() => change(page - 1)}>Previous</Button>
    <span className="text-muted-foreground">Page {page + 1} of {Math.max(1, count)} ({unit})</span>
    <Button variant="outline" size="sm" disabled={page + 1 >= count} onClick={() => change(page + 1)}>Next</Button>
  </div>;
}

// Only the visible page of each array is mounted. Geometry remains available in
// the full response/download rather than expanding thousands of coordinates.
function DataView({ data, depth = 0 }: { data: unknown; depth?: number }) {
  const [page, setPage] = useState(0);
  if (depth > 4) return <p className="text-muted-foreground">Nested detail is available in Full response or Download JSON.</p>;
  if (Array.isArray(data)) {
    if (!data.length) return <p>No records returned.</p>;
    return <div className="report-stack"><Table><TableCaption>{data.length.toLocaleString('en-AU')} returned records; showing {page * 10 + 1}–{Math.min(data.length, page * 10 + 10)}.</TableCaption><TableBody>
      {data.slice(page * 10, page * 10 + 10).map((row, index) => <TableRow key={page * 10 + index}><TableCell className="whitespace-normal"><DataView data={row} depth={depth + 1} /></TableCell></TableRow>)}
    </TableBody></Table>{data.length > 10 && <PageButtons page={page} count={Math.ceil(data.length / 10)} change={setPage} />}</div>;
  }
  if (data === null || typeof data !== 'object') return <p>{scalar(data)}</p>;
  const entries = Object.entries(data as Record<string, unknown>);
  const simple = entries.filter(([, value]) => value === null || typeof value !== 'object');
  const nested = entries.filter(([, value]) => value !== null && typeof value === 'object');
  return <div className="report-stack">
    {simple.length > 0 && <Rows entries={simple.map(([key, value]) => [label(key), scalar(value)])} />}
    {nested.map(([key, value]) => <Collapsible key={key}>
      <CollapsibleTrigger asChild><Button variant="outline" size="sm">{label(key)}{Array.isArray(value) ? ` (${value.length})` : ''}</Button></CollapsibleTrigger>
      <CollapsibleContent className="pt-3"><DataView data={value} depth={depth + 1} /></CollapsibleContent>
    </Collapsible>)}
    {!entries.length && <p>No fields returned.</p>}
  </div>;
}

function FullResponse({ envelope }: { envelope: Envelope }) {
  const text = useMemo(() => JSON.stringify(envelope, null, 2), [envelope]);
  const [page, setPage] = useState(0);
  return <div className="report-stack"><CodeBlock size="sm"><CodeBlockContent wrap className="max-h-64" aria-label="Full API response">{text.slice(page * 10000, (page + 1) * 10000)}</CodeBlockContent></CodeBlock>
    {text.length > 10000 && <><p>Large response displayed in 10,000-character pages. Download JSON preserves the entire response.</p><PageButtons page={page} count={Math.ceil(text.length / 10000)} change={setPage} unit="JSON chunks" /></>}
  </div>;
}

function Download({ envelope, name }: { envelope: Envelope; name: string }) {
  const [error, setError] = useState('');
  function download(value: unknown, extension: string) {
    try {
      const blob = new Blob([JSON.stringify(value, null, 2)], { type: extension === 'geojson' ? 'application/geo+json' : 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = name + '.' + extension;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('Could not download this response. Please retry.'); }
  }
  const data = envelope.data as Record<string, unknown> | null;
  const geometry = envelope.geojson ?? data?.geojson ?? (data?.type === 'FeatureCollection' || data?.type === 'Feature' ? data : undefined);
  return <div className="report-actions"><Button size="sm" variant="outline" onClick={() => download(envelope, 'json')}><DownloadIcon data-icon="inline-start" aria-hidden="true" />Download JSON</Button>
    {geometry != null && <Button size="sm" variant="outline" onClick={() => download(geometry, 'geojson')}>Download GeoJSON</Button>}
    {error && <p role="alert">{error}</p>}</div>;
}

function EndpointResult({ report, task, reload }: { report: ReportSnapshot; task: ReportTask; reload: () => void }) {
  const [result, setResult] = useState<Envelope | null>();
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [documentation, setDocumentation] = useState(task.documentation);
  useEffect(() => {
    let active = true;
    setResult(undefined); setError(false);
    if (!['ok', 'empty', 'unavailable'].includes(task.status)) return;
    void send({ type: 'REPORT_RESULT', reportId: report.id, taskId: task.id }).then(reply => {
      if (!active) return;
      if (!reply.ok || !reply.result) setError(true);
      else { setResult(reply.result); setDocumentation(reply.documentation ?? task.documentation); }
    });
    return () => { active = false; };
  }, [report.id, task.id, task.status, task.savedAt, revision]);
  async function retry() {
    const reply = await send({ type: 'REPORT_RETRY', reportId: report.id, taskId: task.id });
    if (!reply.ok) setError(true);
    reload();
  }
  if (task.status === 'skipped') return <p>{task.reason}</p>;
  if (task.status === 'error') return <Retry error={task.error} retry={() => void retry()} />;
  if (task.status === 'pending' || task.status === 'loading') return <p>Queued. This endpoint loads automatically.</p>;
  if (error) return <Retry error={{ message: 'Could not read the saved response.' }} retry={() => setRevision(v => v + 1)} />;
  if (!result) return <Skeleton className="h-16 w-full" aria-label="Loading saved result" />;
  return <div className="report-stack">
    {task.savedAt && <p className="text-muted-foreground">Response saved {new Date(task.savedAt).toLocaleString('en-AU')}.</p>}
    {(task.status === 'unavailable' || task.status === 'empty') && <><p>{scalar(result.message ?? result.reason ?? 'No data returned for this address.')}</p><Button variant="outline" size="sm" onClick={() => void retry()}>Retry endpoint</Button></>}
    {task.notice && <Alert><AlertDescription>{task.notice}</AlertDescription></Alert>}
    {documentation && <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm">API coverage and limits</Button></CollapsibleTrigger><CollapsibleContent><p className="whitespace-pre-wrap">{documentation}</p></CollapsibleContent></Collapsible>}
    {task.status === 'ok' && result.data && typeof result.data === 'object' && !Array.isArray(result.data) && task.endpoint.endsWith('/basics/all')
      ? <PropertySections keys={['basics']} sections={{ basics: { status: 'ok', data: result.data as Basics } }} retry={() => void retry()} />
      : task.status === 'ok' && result.data && typeof result.data === 'object' && !Array.isArray(result.data) && task.endpoint.endsWith('/valuation/avm')
      ? <PropertySections keys={['valuation']} sections={{ valuation: { status: 'ok', data: result.data as Valuation } }} retry={() => void retry()} />
      : task.endpoint.startsWith('/v1/properties/') && task.endpoint.endsWith('/risks/all') && result.data && typeof result.data === 'object' && Object.values(result.data).every(value => value === null || Array.isArray(value))
      ? <RiskSection data={result.data as Risks} /> : <DataView data={result.data} />}
    <Collapsible><CollapsibleTrigger asChild><Button variant="outline" size="sm">Full response</Button></CollapsibleTrigger><CollapsibleContent className="pt-3"><FullResponse envelope={result} /></CollapsibleContent></Collapsible>
    <Download envelope={result} name={`${report.candidate.id}-${task.endpoint.split('/').slice(4).join('-') || 'profile'}`} />
  </div>;
}

function ReportGroup({ tasks, report, reload }: { tasks: ReportTask[]; report: ReportSnapshot; reload: () => void }) {
  const [page, setPage] = useState(0);
  const visible = tasks.slice(page * 20, page * 20 + 20);
  return <div className="report-stack"><Accordion type="multiple">{visible.map(task => <AccordionItem key={task.id} value={task.id}><AccordionTrigger><span>{task.title}<span className="block text-xs text-muted-foreground">{task.endpoint.includes('area-stats') ? task.id : task.id.includes('?layer=') || task.id.includes('&layer=') ? task.id.split('?')[1] : ''}</span></span><Badge variant={task.status === 'error' ? 'destructive' : 'outline'}>{task.status}</Badge></AccordionTrigger><AccordionContent><EndpointResult report={report} task={task} reload={reload} /></AccordionContent></AccordionItem>)}</Accordion>
    {tasks.length > 20 && <PageButtons page={page} count={Math.ceil(tasks.length / 20)} change={setPage} unit="endpoints" />}
  </div>;
}

export function PropertyReport({ onSave }: { onSave?: (candidate: Candidate) => Promise<void> } = {}) {
  const [report, setReport] = useState<ReportSnapshot | null>();
  const [error, setError] = useState('');
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true, sequence = 0, timer: ReturnType<typeof setTimeout>;
    let latest: ReportSnapshot | null | undefined;
    let pumping = false;
    async function read() {
      const token = ++sequence;
      const reply = await send({ type: 'REPORT_READ' });
      if (!active) return null;
      if (token !== sequence) return latest;
      if (!reply.ok) { setError(reply.error?.message ?? 'Could not load the property report. Reopen the popup to retry.'); return null; }
      latest = reply.report ?? null;
      setError(''); setReport(latest);
      return reply.report;
    }
    async function continueReport() {
      if (pumping || !active) return;
      pumping = true;
      try {
        let current = await read();
        while (active && current?.state === 'running') {
          await send({ type: 'REPORT_CONTINUE' });
          current = await read();
          if (active && current?.state === 'running') await new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); });
        }
      } finally { pumping = false; }
    }
    refresh.current = () => { void read().then(() => { if (!pumping) void continueReport(); }); };
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && 'microburbs.report.summary' in changes) void read().then(current => { if (current?.state === 'running' && !pumping) void continueReport(); });
    };
    chrome.storage.onChanged.addListener(changed);
    void continueReport();
    return () => { active = false; sequence++; clearTimeout(timer); chrome.storage.onChanged.removeListener(changed); };
  }, []);
  async function restart() {
    if (!report) return;
    const reply = await send({ type: 'REPORT_REFRESH', reportId: report.id });
    if (!reply.ok) setError(reply.error?.message ?? 'Could not refresh the report. Please retry.');
    else refresh.current();
  }
  const groups = useMemo(() => {
    const result = new Map<string, ReportTask[]>();
    for (const task of report?.tasks ?? []) result.set(task.group, [...(result.get(task.group) ?? []), task]);
    return [...result];
  }, [report]);
  return <div className="report-stack">
    {error && <Alert variant="destructive"><AlertTitle>Report unavailable</AlertTitle><AlertDescription>{error}<Button variant="outline" size="sm" onClick={() => refresh.current()}>Try again</Button></AlertDescription></Alert>}
    {report === undefined && !error && <Skeleton className="h-24 w-full" aria-label="Loading property report" />}
    {report === null && <Empty><EmptyHeader><EmptyMedia variant="icon"><MapPinIcon aria-hidden="true" /></EmptyMedia><EmptyTitle><h1>No confirmed address yet</h1></EmptyTitle><EmptyDescription>Select an address on a webpage, choose Look up property, and confirm the match. Its full report will appear here.</EmptyDescription></EmptyHeader></Empty>}
    {report && <>
      <PropertyOverview key={report.id} report={report} onSave={onSave} />
      <Collapsible className="report-stack"><CollapsibleTrigger asChild><Button variant="outline" className="w-full">Sources & full property report</Button></CollapsibleTrigger><CollapsibleContent className="report-stack pt-3">
      <Card><CardHeader><CardTitle><h2>Report coverage</h2></CardTitle><CardDescription>GNAF: {report.candidate.id}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">
        <p>{report.completed} of {report.total} requests processed · {report.state}{report.errors ? ` · ${report.errors} failed` : ''}</p>
        <p className="text-muted-foreground">Updated {new Date(report.updatedAt).toLocaleString('en-AU')}. More datasets may appear as the report loads.</p>
        <Button variant="outline" onClick={() => void restart()}><RefreshCwIcon data-icon="inline-start" aria-hidden="true" />Refresh report</Button>
      </CardContent></Card>
      {report.error && <Alert variant="destructive"><AlertDescription>{report.error}</AlertDescription></Alert>}
      <Accordion type="multiple">{groups.map(([group, tasks]) => <AccordionItem key={group} value={group}><AccordionTrigger>{label(group)} ({tasks.length})</AccordionTrigger><AccordionContent>
        <ReportGroup key={report.id + group} tasks={tasks} report={report} reload={() => refresh.current()} />
      </AccordionContent></AccordionItem>)}</Accordion>
      <Collapsible><CollapsibleTrigger asChild><Button size="sm" variant="ghost">Supporting endpoints and coverage</Button></CollapsibleTrigger><CollapsibleContent><ul className="flex flex-col gap-2">{report.supporting.map(item => <li key={item.endpoint}>{item.endpoint}: {item.reason}</li>)}</ul></CollapsibleContent></Collapsible>
      <p className="text-muted-foreground">Source: Microburbs Hackathon API. Returned data may be unavailable or capped by the API. Valuations are estimates; overlays do not replace a planning certificate. Responses stay in this Chrome profile.</p>
      </CollapsibleContent></Collapsible>
      <p className="overview-caption">{report.state === 'running' ? `Loading property data · ${report.completed} of ${report.total} requests processed` : report.state === 'paused' ? 'Report paused. Open the full report for details.' : report.errors ? `Report ready · ${report.errors} requests need attention` : 'Property data saved in this Chrome profile.'}</p>
    </>}
  </div>;
}
