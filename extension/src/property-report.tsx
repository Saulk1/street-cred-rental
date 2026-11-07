import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDownIcon, MapPinIcon, RefreshCwIcon, DownloadIcon } from 'lucide-react';
import { PropertyOverview } from '@/property-overview';
import type { Candidate, LookupError } from '@/types';

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

function Disclosure({ title, children }: { title: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className="report-disclosure" onToggle={event => setOpen(event.currentTarget.open)}><summary>{title}<ChevronDownIcon aria-hidden="true" /></summary>{open && <div className="report-stack report-disclosure-content">{children}</div>}</details>;
}
function Retry({ error, retry }: { error?: LookupError; retry: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const delay = Math.max(0, (error?.retryAt ?? 0) - Date.now());
    if (!delay) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay, 2147483647));
    return () => clearTimeout(timer);
  }, [error?.retryAt, now]);
  const waiting = (error?.retryAt ?? 0) > now;
  return <div className="popup-alert"><p>{error?.message ?? 'Could not read this property data. Please retry.'}</p>{error?.requestId && <p>Request ID: {error.requestId}</p>}{waiting && <p>Retry available after {new Date(error!.retryAt!).toLocaleTimeString()}.</p>}<button className="popup-button" disabled={waiting} onClick={retry}>Retry</button></div>;
}
function PageButtons({ page, count, change, unit = 'rows' }: { page: number; count: number; change: (page: number) => void; unit?: string }) {
  return <div className="report-actions"><button className="popup-button compact" disabled={page === 0} onClick={() => change(page - 1)}>Previous</button><span className="overview-muted">Page {page + 1} of {Math.max(1, count)} ({unit})</span><button className="popup-button compact" disabled={page + 1 >= count} onClick={() => change(page + 1)}>Next</button></div>;
}
function DataView({ data, depth = 0 }: { data: unknown; depth?: number }) {
  const [page, setPage] = useState(0);
  if (depth > 4) return <p className="overview-muted">Nested detail is available in Full response or Download JSON.</p>;
  if (Array.isArray(data)) {
    if (!data.length) return <p>No records returned.</p>;
    return <div className="report-stack"><p className="overview-caption">{data.length.toLocaleString('en-AU')} returned records; showing {page * 10 + 1}–{Math.min(data.length, page * 10 + 10)}.</p><ol className="report-records" start={page * 10 + 1}>{data.slice(page * 10, page * 10 + 10).map((row, index) => <li key={page * 10 + index}><DataView data={row} depth={depth + 1} /></li>)}</ol>{data.length > 10 && <PageButtons page={page} count={Math.ceil(data.length / 10)} change={setPage} />}</div>;
  }
  if (data === null || typeof data !== 'object') return <p>{scalar(data)}</p>;
  const entries = Object.entries(data as Record<string, unknown>);
  const simple = entries.filter(([, value]) => value === null || typeof value !== 'object');
  const nested = entries.filter(([, value]) => value !== null && typeof value === 'object');
  return <div className="report-stack">{simple.length > 0 && <dl className="report-facts">{simple.map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{scalar(value)}</dd></div>)}</dl>}{nested.map(([key, value]) => <Disclosure key={key} title={label(key) + (Array.isArray(value) ? ` (${value.length})` : '')}><DataView data={value} depth={depth + 1} /></Disclosure>)}{!entries.length && <p>No fields returned.</p>}</div>;
}
function FullResponse({ envelope }: { envelope: Envelope }) {
  const text = useMemo(() => JSON.stringify(envelope, null, 2), [envelope]);
  const [page, setPage] = useState(0);
  return <div className="report-stack"><pre className="report-json" aria-label="Full API response" tabIndex={0}><code>{text.slice(page * 10000, (page + 1) * 10000)}</code></pre>{text.length > 10000 && <><p>Large response displayed in 10,000-character pages. Download JSON preserves the entire response.</p><PageButtons page={page} count={Math.ceil(text.length / 10000)} change={setPage} unit="JSON chunks" /></>}</div>;
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
  return <div className="report-actions"><button className="popup-button compact" onClick={() => download(envelope, 'json')}><DownloadIcon aria-hidden="true" />Download JSON</button>{geometry != null && <button className="popup-button compact" onClick={() => download(geometry, 'geojson')}>Download GeoJSON</button>}{error && <p role="alert">{error}</p>}</div>;
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
  if (!result) return <p className="overview-muted" aria-busy="true">Loading saved result…</p>;
  return <div className="report-stack">{task.savedAt && <p className="overview-caption">Response saved {new Date(task.savedAt).toLocaleString('en-AU')}.</p>}{(task.status === 'unavailable' || task.status === 'empty') && <><p>{scalar(result.message ?? result.reason ?? 'No data returned for this address.')}</p><button className="popup-button compact" onClick={() => void retry()}>Retry endpoint</button></>}{task.notice && <p className="popup-alert">{task.notice}</p>}{documentation && <Disclosure title="API coverage and limits"><p className="report-documentation">{documentation}</p></Disclosure>}<DataView data={result.data} /><Disclosure title="Full response"><FullResponse envelope={result} /></Disclosure><Download envelope={result} name={`${report.candidate.id}-${task.endpoint.split('/').slice(4).join('-') || 'profile'}`} /></div>;
}
function ReportGroup({ tasks, report, reload }: { tasks: ReportTask[]; report: ReportSnapshot; reload: () => void }) {
  const [page, setPage] = useState(0);
  const visible = tasks.slice(page * 20, page * 20 + 20);
  return <div className="report-stack">{visible.map(task => <Disclosure key={task.id} title={<><span>{task.title}<span className="report-task-caption">{task.endpoint.includes('area-stats') ? task.id : task.id.includes('?layer=') || task.id.includes('&layer=') ? task.id.split('?')[1] : ''}</span></span><span className="popup-badge" data-tone={task.status === 'error' ? 'warning' : 'neutral'}>{task.status}</span></>}><EndpointResult report={report} task={task} reload={reload} /></Disclosure>)}{tasks.length > 20 && <PageButtons page={page} count={Math.ceil(tasks.length / 20)} change={setPage} unit="endpoints" />}</div>;
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
    {error && <div className="popup-alert" role="alert"><h2>Report unavailable</h2><p>{error}</p><button className="popup-button compact" onClick={() => refresh.current()}>Try again</button></div>}
    {report === undefined && !error && <p className="popup-loading" aria-busy="true">Loading property report…</p>}
    {report === null && <div className="popup-empty"><MapPinIcon aria-hidden="true" /><h1>No confirmed address yet</h1><p>Select an address on a webpage, choose Look up property, and confirm the match. Its full report will appear here.</p></div>}
    {report && <>
      <PropertyOverview key={report.id} report={report} onSave={onSave} />
      <Disclosure title="Sources & full property report">
        <article className="overview-card"><header><h2>Report coverage</h2><p className="overview-caption">GNAF: {report.candidate.id}</p></header><p>{report.completed} of {report.total} requests processed · {report.state}{report.errors ? ` · ${report.errors} failed` : ''}</p><p className="overview-muted">Updated {new Date(report.updatedAt).toLocaleString('en-AU')}. More datasets may appear as the report loads.</p><button className="popup-button" onClick={() => void restart()}><RefreshCwIcon aria-hidden="true" />Refresh report</button></article>
        {report.error && <p className="popup-alert" role="alert">{report.error}</p>}
        {groups.map(([group, tasks]) => <Disclosure key={group} title={`${label(group)} (${tasks.length})`}><ReportGroup key={report.id + group} tasks={tasks} report={report} reload={() => refresh.current()} /></Disclosure>)}
        <Disclosure title="Supporting endpoints and coverage"><ul className="report-supporting">{report.supporting.map(item => <li key={item.endpoint}>{item.endpoint}: {item.reason}</li>)}</ul></Disclosure>
        <p className="overview-caption">Source: Microburbs Hackathon API. Returned data may be unavailable or capped by the API. Valuations are estimates; overlays do not replace a planning certificate. Responses stay in this Chrome profile.</p>
      </Disclosure>
      <p className="overview-caption report-status">{report.state === 'running' ? `Loading property data · ${report.completed} of ${report.total} requests processed` : report.state === 'paused' ? 'Report paused. Open the full report for details.' : report.errors ? `Report ready · ${report.errors} requests need attention` : 'Property data saved in this Chrome profile.'}</p>
    </>}
  </div>;
}
