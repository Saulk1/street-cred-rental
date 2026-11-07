import { useEffect, useState } from 'react';
import { TriangleAlertIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import type { ApiSection, LookupError } from '@/types';

export const absent = 'Not available';
export const displayValue = (input: unknown) => input === null || input === undefined ? absent : String(input);
export const money = (input: number | null | undefined) => typeof input === 'number'
  ? new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(input) : absent;
export const distance = (metres: number | null) => metres === null ? absent : `${metres.toLocaleString('en-AU')} m`;

export function Rows({ entries }: { entries: [string, string][] }) {
  return <dl className="fact-grid">{entries.map(([label, display]) => <div key={label}><dt>{label}</dt><dd>{display}</dd></div>)}</dl>;
}

export function Retry({ error, retry }: { error?: LookupError; retry: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const delay = Math.max(0, (error?.retryAt ?? 0) - Date.now());
    if (!delay) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay, 2147483647));
    return () => clearTimeout(timer);
  }, [error?.retryAt, now]);
  const waiting = (error?.retryAt ?? 0) > now;
  return <Alert variant="destructive" role="group"><TriangleAlertIcon aria-hidden="true" /><AlertDescription>
    <p>{error?.message ?? 'Could not look up this property. Please retry.'}</p>
    {error?.requestId && <p>Request ID: {error.requestId}</p>}
    {waiting && <p>Retry available after {new Date(error!.retryAt!).toLocaleTimeString()}.</p>}
    <Button variant="outline" disabled={waiting} onClick={retry}>Retry</Button>
  </AlertDescription></Alert>;
}

export type Resource<T> = ApiSection<T> | { status: 'idle' | 'loading' };
export function ResourceContent<T>({ resource, retry, children }: {
  resource: Resource<T>; retry: () => void; children: (data: T) => React.ReactNode;
}) {
  if (resource.status === 'error') return <Retry error={resource.error} retry={retry} />;
  if (resource.status === 'empty') return <Empty><EmptyHeader><EmptyTitle>No data returned</EmptyTitle></EmptyHeader></Empty>;
  if (resource.status !== 'ok') return <div aria-label="Loading section" aria-busy="true"><Skeleton className="h-16 w-full" /></div>;
  return <>{children(resource.data)}</>;
}
