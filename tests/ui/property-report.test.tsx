import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PropertyReport, type ReportSnapshot } from '../../src/property-report';

let report: ReportSnapshot | null;
let send: ReturnType<typeof vi.fn>;
let changes: ((changes: Record<string, unknown>, area: string) => void)[];
const base = (): ReportSnapshot => ({ id: 'report-1', candidate: { id: 'GANSW1', label: '26 Example St' }, state: 'complete', selectedAt: 1, updatedAt: 1, total: 1, completed: 1, errors: 0,
  tasks: [{ id: '/v1/properties/GANSW1/basics/all', endpoint: '/v1/properties/{gnaf_id}/basics/all', title: 'All basics', group: 'Property · basics', status: 'ok', savedAt: 1 }], supporting: [] });

beforeEach(() => {
  report = base(); changes = [];
  send = vi.fn(async (message: any) => {
    if (message.type === 'REPORT_READ') return { ok: true, report: structuredClone(report) };
    if (message.type === 'REPORT_RESULT') return { ok: true, result: { data: { dwelling_type: 'house', bed_count: 0, bath_count: null, parking_count: 1, land_area_sqm: 120 }, available: true } };
    return { ok: true };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send }, storage: { onChanged: {
    addListener: (fn: any) => changes.push(fn), removeListener: (fn: any) => { changes = changes.filter(c => c !== fn); },
  } } });
});
async function details() {
  const user = userEvent.setup(); render(<PropertyReport />);
  await screen.findByRole('heading', { name: '26 Example St' });
  await user.click(screen.getByRole('button', { name: 'Sources & full property report' }));
  await user.click(screen.getByRole('button', { name: /Property · basics/ }));
  await user.click(screen.getByRole('button', { name: /All basics/ }));
  return user;
}

it('restores the confirmed address and reads payloads only when their disclosure opens', async () => {
  render(<PropertyReport />);
  await screen.findByRole('heading', { name: '26 Example St' });
  expect(send.mock.calls.some(([message]) => message.type === 'REPORT_RESULT')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Sources & full property report' }));
  expect(screen.getByText(/1 of 1 requests processed/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Property · basics/ }));
  fireEvent.click(screen.getByRole('button', { name: /All basics/ }));
  expect(await screen.findByText('house')).toBeVisible();
  expect(screen.getByText('0')).toBeVisible();
  expect(screen.getAllByText('Not available').some(node => node.tagName === 'DD')).toBe(true);
});

it('renders complete envelopes as literal JSON, with a download action', async () => {
  const user = await details();
  await screen.findByText('house');
  await user.click(screen.getByRole('button', { name: 'Full response' }));
  expect(screen.getByLabelText('Full API response')).toHaveTextContent('"available": true');
  expect(screen.getByRole('button', { name: 'Download JSON' })).toBeVisible();
});

it('paginates large datasets without dropping records or issuing new fetches', async () => {
  report!.tasks[0].endpoint = '/v1/properties/{gnaf_id}/sale-history';
  send.mockImplementation(async (message: any) => message.type === 'REPORT_READ' ? { ok: true, report } : { ok: true, result: { data: Array.from({ length: 12 }, (_, index) => `Record ${index + 1}`) } });
  const user = await details();
  expect(await screen.findByText('Record 10')).toBeVisible();
  expect(screen.queryByText('Record 11')).toBeNull();
  const calls = send.mock.calls.length;
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByText('Record 12')).toBeVisible();
  expect(send).toHaveBeenCalledTimes(calls);
});

it('keeps successful results while surfacing partial errors and scoped retry', async () => {
  report!.errors = 1; report!.tasks[0].status = 'error'; report!.tasks[0].error = { message: 'Unavailable valuation' };
  const user = await details();
  expect(screen.getByText('Unavailable valuation')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(send).toHaveBeenCalledWith({ type: 'REPORT_RETRY', reportId: 'report-1', taskId: report!.tasks[0].id });
});

it('shows an actionable empty state and follows newer confirmed selections', async () => {
  report = null; render(<PropertyReport />);
  expect(await screen.findByText('No confirmed address yet')).toBeVisible();
  report = base(); report.id = 'report-2'; report.candidate.label = 'New address';
  await act(async () => { changes.forEach(fn => fn({ 'microburbs.report.summary': {} }, 'local')); });
  expect(await screen.findByRole('heading', { name: 'New address' })).toBeVisible();
});

it('refreshes by report id and removes subscriptions when the popup closes', async () => {
  const view = render(<PropertyReport />);
  await screen.findByRole('heading', { name: '26 Example St' });
  fireEvent.click(screen.getByRole('button', { name: 'Sources & full property report' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh report' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'REPORT_REFRESH', reportId: 'report-1' }));
  view.unmount(); expect(changes).toHaveLength(0);
});

it('ignores an old payload response after the confirmed address changes', async () => {
  let resolve!: (value: any) => void;
  send.mockImplementation(async (message: any) => message.type === 'REPORT_READ' ? { ok: true, report: structuredClone(report) } : new Promise(done => { resolve = done; }));
  await details();
  report = base(); report.id = 'report-2'; report.candidate.label = 'New address'; report.tasks = [];
  await act(async () => { changes.forEach(fn => fn({ 'microburbs.report.summary': {} }, 'local')); });
  await act(async () => resolve({ ok: true, result: { data: { secret: 'Old address data' } } }));
  expect(screen.getByRole('heading', { name: 'New address' })).toBeVisible();
  expect(screen.queryByText('Old address data')).toBeNull();
});
