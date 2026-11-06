import { it, expect, vi, afterEach } from 'vitest';
import { act, within, fireEvent } from '@testing-library/react';
import { attachPropertyLookup } from '../../src/property-lookup';
import { mountSaveAction, mountWidget } from '../../src/injected';
const candidate = { id: 'GANSW1', label: '26 Tudor Street, Surry Hills' };
const reply = () => ({ ok: true, sections: { basics: { status: 'ok', data: { dwelling_type: 'house', bed_count: 0, bath_count: null, parking_count: 1, land_area_sqm: 120 } }, valuation: { status: 'ok', data: { predicted_price: 1200000, predicted_price_low: 1000000, predicted_price_high: 1400000, prediction_date: '2026-04-20', confidence_score: 70 } }, risks: { status: 'ok', data: { bushfire: [{ on_property: true, nearest_distance_m: 0 }], flood: [{ on_property: false, nearest_distance_m: 257 }], hv_power_line: [{ on_property: false, nearest_distance_m: 100 }], public_housing: [{ on_property: true, value: '3.4%', value_unit: 'Properties Proportion', nearest_distance_m: 0 }] } } } });
let disposals: (() => void)[] = [];
afterEach(() => { act(() => disposals.forEach(fn => fn())); disposals = []; document.body.replaceChildren(); vi.useRealTimers(); });
function mount(handler: any) {
  const send = vi.fn(handler); vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  const host = document.createElement('div'); document.body.append(host); const shadow = host.attachShadow({ mode: 'open' });
  const reposition = vi.fn(); let active: ReturnType<typeof attachPropertyLookup>;
  act(() => { active = attachPropertyLookup({ host, shadow, selection: { text: candidate.label }, isCurrent: () => host.isConnected, reposition }); });
  let disposed = false; const dispose = () => { if (!disposed) { active.dispose(); disposed = true; } }; disposals.push(dispose);
  return { host, shadow, send, reposition, get active() { return active; }, ui: within(shadow as unknown as HTMLElement), dispose };
}
it('auto-loads a single match, zero vs missing values and accurate overlay labels', async () => {
  const app = mount((m: any) => Promise.resolve(m.type === 'SEARCH_ADDRESS' ? { ok: true, candidates: [candidate] } : reply()));
  await act(async () => { await app.active.start(); });
  expect(app.send.mock.calls.map(c => c[0].type)).toEqual(['SEARCH_ADDRESS', 'PROPERTY_DETAILS']);
  expect(app.ui.getByText('$1,200,000')).toBeVisible(); expect(app.ui.getByText('0')).toBeVisible();
  expect(app.ui.getAllByText('Not available').length).toBeGreaterThan(0);
  for (const label of ["Overlay at the property's address point", "Not at the property's address point", 'Nearby feature', 'Containing Census area: 3.4% (Properties Proportion); 0 m away']) expect(app.ui.getByText(label)).toBeVisible();
  expect(app.shadow.activeElement).toHaveClass('property-results'); expect(app.reposition).toHaveBeenCalled();
});
it('requires a choice for multiple matches and supports choosing another', async () => {
  const app = mount((m: any) => Promise.resolve(m.type === 'SEARCH_ADDRESS' ? { ok: true, candidates: [candidate, { id: 'unit', label: 'Unit 2' }] } : reply()));
  await act(async () => { await app.active.start(); }); expect(app.send).toHaveBeenCalledTimes(1);
  await act(async () => fireEvent.click(app.ui.getByRole('button', { name: 'Unit 2' })));
  expect(app.send).toHaveBeenLastCalledWith({ type: 'PROPERTY_DETAILS', id: 'unit' });
  act(() => fireEvent.click(app.ui.getByRole('button', { name: 'Choose another match' })));
  expect(app.ui.getByText('Choose the matching address')).toBeVisible();
});
it('retains facts during partial failure and retries property details', async () => {
  const result: any = reply(); result.sections.valuation = { status: 'error', error: { message: 'Unavailable valuation', requestId: 'support-id' } };
  const app = mount((m: any) => Promise.resolve(m.type === 'SEARCH_ADDRESS' ? { ok: true, candidates: [candidate] } : result));
  await act(async () => { await app.active.start(); });
  expect(app.ui.getByText('house')).toBeVisible(); expect(app.ui.getByText('Request ID: support-id')).toBeVisible();
  await act(async () => fireEvent.click(app.ui.getByRole('button', { name: 'Retry' })));
  expect(app.send).toHaveBeenCalledTimes(3);
});
it('shows empty results and configuration errors, without disabling independent save', async () => {
  const app = mount(() => Promise.resolve({ ok: true, candidates: [] }));
  await act(async () => { await app.active.start(); }); expect(app.ui.getByText(/Coverage is limited/)).toBeVisible();
  app.send.mockResolvedValueOnce({ ok: false, error: { message: 'Set the key in .env.local and rebuild.' } });
  await act(async () => { await app.active.start(); }); expect(app.ui.getByText(/.env.local/)).toBeVisible(); expect(app.active.button).not.toBeDisabled();
  let save!: ReturnType<typeof mountSaveAction>; act(() => { save = mountSaveAction(app.shadow); }); disposals.push(() => save.dispose()); expect(save.button).not.toBeDisabled();
  act(() => save.update({ disabled: true, saved: true, message: 'Note saved.' })); expect(app.ui.getByText('Saved to notes')).toBeVisible();
});
it('honors Retry-After and cancels timers on disposal', async () => {
  vi.useFakeTimers(); const app = mount(() => Promise.resolve({ ok: false, error: { message: 'Rate limited', retryAt: Date.now() + 1000 } }));
  await act(async () => { await app.active.start(); }); expect(app.ui.getByRole('button', { name: 'Retry' })).toBeDisabled();
  act(() => vi.advanceTimersByTime(1001)); expect(app.ui.getByRole('button', { name: 'Retry' })).not.toBeDisabled();
  act(() => app.dispose()); expect(vi.getTimerCount()).toBe(0);
});
it('prevents duplicate requests and discards responses after unmount', async () => {
  let finish!: (value: any) => void; const app = mount(() => new Promise(resolve => { finish = resolve; }));
  let promise!: Promise<void>; act(() => { promise = app.active.start(); });
  await act(async () => { await app.active.start(); }); expect(app.send).toHaveBeenCalledTimes(1);
  act(() => app.dispose()); await act(async () => { finish({ ok: true, candidates: [candidate] }); await promise; }); expect(app.send).toHaveBeenCalledTimes(1); expect(app.shadow.children).toHaveLength(0);
});
it('widget uses an accessible close control', () => {
  const host = document.createElement('div'); document.body.append(host); const shadow = host.attachShadow({ mode: 'open' }); const close = vi.fn(); let ui!: ReturnType<typeof mountWidget>;
  act(() => { ui = mountWidget(shadow, close); }); disposals.push(() => ui.dispose()); fireEvent.click(within(shadow as any).getByRole('button', { name: 'Close Microburbs Facts widget' })); expect(close).toHaveBeenCalledOnce();
});
