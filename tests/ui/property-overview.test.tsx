import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PropertyOverview } from '../../src/property-overview';
import type { ReportSnapshot } from '../../src/property-report';

let report: ReportSnapshot;
let payloads: Record<string, unknown>;
let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  payloads = {
    '/rent-history-latest': { price: 720, date: '2026-09-01', type: 'For Rent' },
    '/valuation/avm': { predicted_price: 805500, predicted_price_low: 628000, predicted_price_high: 983000, confidence_score: 95, prediction_date: '2026-09-01' },
    '/sale-history-latest': { price: 612000, type: 'For Sale', date: '2019-03-01' },
    '/comparables/recent-sales-nearby': Array.from({ length: 4 }, (_, index) => ({ address: `Nearby home ${index + 1}`, price: 790000, bedrooms: 3, dist_km: 0.3, date_sold: '2026-09-01' })),
    '/risks/all': { flood: [], bushfire: [{ on_property: true }] },
  };
  report = { id: 'report-1', candidate: { id: 'GANSW1', label: '26 Example St' }, state: 'complete', selectedAt: 1, updatedAt: 1, total: 5, completed: 5, errors: 0,
    tasks: Object.keys(payloads).map(suffix => ({ id: suffix, endpoint: '/v1/properties/{gnaf_id}' + suffix, title: suffix, group: 'Property', status: 'ok', savedAt: 1 })), supporting: [] };
  send = vi.fn(async (message: { taskId: string }) => ({ ok: true, result: { data: structuredClone(payloads[message.taskId]) } }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
});

it('compares an entered rent with a labelled observation and retains it across tab switches', async () => {
  const user = userEvent.setup(); render(<PropertyOverview report={report} />);
  expect(await screen.findByRole('heading', { name: /\$720\s*\/wk/ })).toBeVisible();
  expect(screen.getByText(/past listing, not a current rent estimate/)).toBeVisible();
  const input = screen.getByLabelText('Compare with the asking rent');
  await user.type(input, '750');
  expect(screen.getByText('Asking rent is 4% above the last advertised rent.')).toBeVisible();
  await user.click(screen.getByRole('tab', { name: 'Buy' }));
  expect(input).not.toBeVisible();
  expect(await screen.findByRole('heading', { name: '$805,500' })).toBeVisible();
  expect(screen.getByText('Latest sale listing')).toBeVisible();
  expect(screen.queryByText('Last sale')).toBeNull();
  await user.click(screen.getByRole('tab', { name: 'Rental' }));
  expect(input).toHaveValue('750');
  await user.clear(input); await user.type(input, '-1');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAccessibleDescription(/Enter a weekly amount/);
});

it('expands saved comparable sales and distinguishes overlays from risk ratings', async () => {
  const user = userEvent.setup(); render(<PropertyOverview report={report} />);
  await user.click(screen.getByRole('tab', { name: 'Buy' }));
  expect(await screen.findByText('Nearby home 3')).toBeVisible();
  expect(screen.queryByText('Nearby home 4')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'See all 4 comparable sales' }));
  expect(screen.getByText('Nearby home 4')).toBeVisible();
  expect(screen.getByText('No overlay at point')).toBeVisible();
  expect(screen.getByText('Overlay at address')).toBeVisible();
  expect(screen.getByText('A score is not available from this API.')).toBeVisible();
});

it('keeps missing rent and zero rent distinct without fabricating a comparison', async () => {
  payloads['/rent-history-latest'] = { price: 0 };
  const user = userEvent.setup(); render(<PropertyOverview report={report} />);
  expect(await screen.findByRole('heading', { name: /\$0\s*\/wk/ })).toBeVisible();
  await user.type(screen.getByLabelText('Compare with the asking rent'), '750');
  expect(screen.queryByText(/% above/)).toBeNull();
});

it('ignores saved payloads from an older report after the confirmed address changes', async () => {
  let resolve!: (reply: unknown) => void;
  send.mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = render(<PropertyOverview report={report} />);
  view.rerender(<PropertyOverview report={{ ...report, id: 'report-2', candidate: { id: 'GANSW2', label: 'New address' }, tasks: [] }} />);
  await act(async () => resolve({ ok: true, result: { data: { price: 999 } } }));
  expect(screen.queryByText('$999')).toBeNull();
  expect(screen.getByRole('heading', { name: 'New address' })).toBeVisible();
});

it('saves only the confirmed address and reports clipboard failure', async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  const copy = vi.fn(async () => { throw new Error(); });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  render(<PropertyOverview report={report} onSave={save} />);
  await user.click(screen.getByRole('button', { name: 'Save to notes' }));
  expect(save).toHaveBeenCalledWith(report.candidate);
  expect(screen.getByRole('status')).toHaveTextContent('Address saved');
  await user.click(screen.getByRole('button', { name: 'Share this home' }));
  expect(copy).toHaveBeenCalledWith('26 Example St');
  expect(screen.getByRole('status')).toHaveTextContent('Could not copy the address');
});
