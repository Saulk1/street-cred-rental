import { it, expect, vi, afterEach } from 'vitest';
import { act, within, fireEvent } from '@testing-library/react';
import { attachPropertyLookup } from '../../src/property-lookup';
import { mountSaveAction, mountWidget } from '../../src/injected';
const candidate = { id: 'GANSW1', label: '26 Tudor Street, Surry Hills' };
const reply = () => ({ ok: true, sections: { basics: { status: 'ok', data: { dwelling_type: 'house', bed_count: 0, bath_count: null, parking_count: 1, land_area_sqm: 120 } }, valuation: { status: 'ok', data: { predicted_price: 1200000, predicted_price_low: 1000000, predicted_price_high: 1400000, prediction_date: '2026-04-20', confidence_score: 70 } }, risks: { status: 'ok', data: { bushfire: [{ on_property: true, nearest_distance_m: 0 }], flood: [{ on_property: false, nearest_distance_m: 257 }], hv_power_line: [{ on_property: false, nearest_distance_m: 100 }], public_housing: [{ on_property: true, value: '3.4%', value_unit: 'Properties Proportion', nearest_distance_m: 0 }] } } } });
let disposals: (() => void)[] = [];
afterEach(() => { act(() => disposals.forEach(fn => fn())); disposals = []; document.body.replaceChildren(); vi.useRealTimers(); });
function mount(handler: any) {
  const send = vi.fn(handler); vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path, sendMessage: send } });
  const host = document.createElement('div'); document.body.append(host); const shadow = host.attachShadow({ mode: 'open' });
  const reposition = vi.fn(); let active: ReturnType<typeof attachPropertyLookup>;
  act(() => { active = attachPropertyLookup({ host, shadow, selection: { text: candidate.label }, isCurrent: () => host.isConnected, reposition }); });
  let disposed = false; const dispose = () => { if (!disposed) { active.dispose(); disposed = true; } }; disposals.push(dispose);
  return { host, shadow, send, reposition, get active() { return active; }, ui: within(shadow as unknown as HTMLElement), dispose };
}
it('auto-loads a single match, zero vs missing values and accurate overlay labels', async () => {
  const app = mount((m: any) => Promise.resolve(m.type === 'SEARCH_ADDRESS' ? { ok: true, candidates: [candidate] } : reply()));
  await act(async () => { await app.active.start(); });
  expect(app.send.mock.calls.map(c => c[0].type)).toEqual(['SEARCH_ADDRESS', 'CONFIRM_PROPERTY', 'PROPERTY_DETAILS']);
  expect(app.send).toHaveBeenCalledWith({ type: 'CONFIRM_PROPERTY', candidate });
  expect(app.ui.getByText('$1,200,000')).toBeVisible(); expect(app.ui.getByText('0')).toBeVisible();
  expect(app.ui.getAllByText('Not available').length).toBeGreaterThan(0);
  expect(app.shadow.activeElement).toHaveClass('property-results');
  act(() => fireEvent.click(app.ui.getByRole('button', { name: 'Overlays and nearby features' })));
  for (const label of ["Overlay at the property's address point", "Not at the property's address point", 'Nearby feature', 'Containing Census area: 3.4% (Properties Proportion); 0 m away']) expect(app.ui.getByText(label)).toBeVisible();
  expect(app.reposition).toHaveBeenCalled();
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
  expect(app.send).toHaveBeenCalledTimes(4);
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

// Schemas from the bundled hackathon YAML, with invented observations.
const extraFixture = (await import('../fixtures/property-sections.json')).default;
function expandedHandler(message: any) {
  if (message.type === 'SEARCH_ADDRESS') return Promise.resolve({ ok: true, candidates: [candidate] });
  if (message.type === 'PROPERTY_DETAILS') return Promise.resolve(reply());
  if (message.section === 'market') return Promise.resolve({ ok: true, market: {
    sale: { status: 'ok', data: extraFixture.sale }, rent: { status: 'ok', data: extraFixture.rent },
  } });
  return Promise.resolve({ ok: true, section: { status: 'ok', data: extraFixture[message.section as 'planning'] } });
}
async function openSection(app: ReturnType<typeof mount>, name: string) {
  await act(async () => fireEvent.click(app.ui.getByRole('button', { name, exact: true })));
}
it('loads each section on first expansion and caches collapse/reopen without hiding the overview', async () => {
  const app = mount(expandedHandler);
  await act(async () => { await app.active.start(); });
  expect(app.send).toHaveBeenCalledTimes(3);
  await openSection(app, 'Zoning and planning');
  expect(app.send).toHaveBeenLastCalledWith({ type: 'PROPERTY_SECTION', id: candidate.id, section: 'planning' });
  expect(app.ui.getByText('R2')).toBeVisible();
  expect(app.ui.getByText('Original unit')).toBeVisible();
  expect(app.ui.getByText('custom')).toBeVisible();
  expect(app.ui.getByText('$1,200,000')).toBeVisible();
  await openSection(app, 'Zoning and planning');
  await openSection(app, 'Zoning and planning');
  expect(app.send).toHaveBeenCalledTimes(4);
  await openSection(app, 'Nearby transport');
  expect(app.ui.getByRole('button', { name: 'Zoning and planning' })).toHaveAttribute('aria-expanded', 'true');
  expect(app.ui.getByText('Bus stop · 130 m')).toBeVisible();
  expect(app.ui.getByText('Example Station · 600 m')).toBeVisible();
  expect(app.ui.getAllByText('No stops within the search radius.')).toHaveLength(2);
});
it('preserves listing labels, month-level dates and unspecified rental period', async () => {
  const app = mount(expandedHandler); await act(async () => { await app.active.start(); });
  await openSection(app, 'Latest market activity');
  expect(app.ui.getByText('For Sale')).toBeVisible(); expect(app.ui.queryByText('Recorded sale price (AUD)')).toBeNull();
  expect(app.ui.getByText('Advertised price (AUD)')).toBeVisible();
  expect(app.ui.getByText('May 2025')).toBeVisible(); expect(app.ui.getByText('July 2025')).toBeVisible();
  expect(app.ui.getByText('Advertised rent (AUD)')).toBeVisible(); expect(app.ui.getByText('$3,000')).toBeVisible();
  expect(app.ui.queryByText(/\$3,000\s*\/\s*week/)).toBeNull();
});
it('shows five list results initially and expands fetched data without new API calls', async () => {
  const app = mount(expandedHandler); await act(async () => { await app.active.start(); });
  await openSection(app, 'Nearby schools');
  expect(app.ui.queryByText('Example School Six')).toBeNull();
  expect(app.ui.getByText(/Showing 5 of 6 returned schools/)).toBeVisible();
  await openSection(app, 'Show more schools');
  expect(app.ui.getByText('Example School Six')).toBeVisible(); expect(app.send).toHaveBeenCalledTimes(4);
  await openSection(app, 'Nearby amenities');
  expect(app.ui.getByText('Total: 8')).toBeVisible(); expect(app.ui.getByText('Showing 5 of 6 returned results.')).toBeVisible();
  expect(app.ui.queryByText('Example Market Six')).toBeNull();
  await openSection(app, 'Show more supermarkets');
  expect(app.ui.getByText('Example Market Six')).toBeVisible(); expect(app.send).toHaveBeenCalledTimes(5);
  expect(app.ui.getByText('Total: 0')).toBeVisible(); expect(app.ui.getByText('Unnamed amenity')).toBeVisible();
});
it('market retry fetches only the failed resource and keeps the successful observation', async () => {
  const app = mount((m: any) => m.type === 'PROPERTY_SECTION' && m.section === 'market' && !m.part
    ? Promise.resolve({ ok: true, market: { sale: { status: 'ok', data: extraFixture.sale }, rent: { status: 'error', error: { message: 'Rental unavailable' } } } })
    : expandedHandler(m));
  await act(async () => { await app.active.start(); }); await openSection(app, 'Latest market activity');
  expect(app.ui.getByText('$990,000')).toBeVisible(); expect(app.ui.getByText('Rental unavailable')).toBeVisible();
  await openSection(app, 'Retry');
  expect(app.send).toHaveBeenLastCalledWith({ type: 'PROPERTY_SECTION', id: candidate.id, section: 'market', part: 'rent' });
  expect(app.ui.getByText('$990,000')).toBeVisible(); expect(app.ui.getByText('$3,000')).toBeVisible();
});
it('distinguishes empty data, empty lists and errors; retries after Retry-After', async () => {
  vi.useFakeTimers();
  const app = mount((m: any) => m.type !== 'PROPERTY_SECTION' ? expandedHandler(m)
    : Promise.resolve({ ok: true, section: m.section === 'planning' ? { status: 'empty' } : m.section === 'schools' ? { status: 'ok', data: [] } : { status: 'error', error: { message: 'Please wait', retryAt: Date.now() + 1000 } } }));
  await act(async () => { await app.active.start(); });
  await openSection(app, 'Zoning and planning'); expect(app.ui.getByText('No data returned')).toBeVisible();
  await openSection(app, 'Nearby schools'); expect(app.ui.getByText('No nearby schools returned')).toBeVisible();
  await openSection(app, 'Nearby transport'); expect(app.ui.getByRole('button', { name: 'Retry' })).toBeDisabled();
  act(() => vi.advanceTimersByTime(1001)); expect(app.ui.getByRole('button', { name: 'Retry' })).not.toBeDisabled();
  act(() => app.dispose());
});
it('keeps one in-flight request across collapse/reopen and discards it after choosing another match', async () => {
  let finish!: (v: any) => void;
  const app = mount((m: any) => m.type === 'PROPERTY_SECTION' ? new Promise(resolve => { finish = resolve; }) : m.type === 'SEARCH_ADDRESS'
    ? Promise.resolve({ ok: true, candidates: [candidate, { id: 'other', label: 'Other address' }] }) : expandedHandler(m));
  await act(async () => { await app.active.start(); }); await openSection(app, candidate.label);
  await openSection(app, 'Nearby schools'); await openSection(app, 'Nearby schools'); await openSection(app, 'Nearby schools');
  expect(app.send.mock.calls.filter(c => c[0].type === 'PROPERTY_SECTION')).toHaveLength(1);
  await openSection(app, 'Choose another match'); await openSection(app, 'Other address');
  await act(async () => finish({ ok: true, section: { status: 'ok', data: extraFixture.schools } }));
  expect(app.ui.queryByText('Example Primary School')).toBeNull();
  expect(app.ui.getByRole('button', { name: 'Nearby schools' })).toHaveAttribute('aria-expanded', 'false');
});
it('keeps loaded collapsed content searchable and synchronizes expansion on beforematch', async () => {
  const prior = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'onbeforematch');
  Object.defineProperty(HTMLElement.prototype, 'onbeforematch', { configurable: true, value: null });
  try {
    const app = mount(expandedHandler); await act(async () => { await app.active.start(); });
    await openSection(app, 'Zoning and planning'); await openSection(app, 'Zoning and planning');
    const hidden = app.ui.getByText('R2').closest('[hidden]')!;
    expect(hidden).toHaveAttribute('hidden', 'until-found');
    act(() => hidden.dispatchEvent(new Event('beforematch', { bubbles: true })));
    expect(app.ui.getByRole('button', { name: 'Zoning and planning' })).toHaveAttribute('aria-expanded', 'true');
    expect(hidden).not.toHaveAttribute('hidden'); expect(app.send).toHaveBeenCalledTimes(4);
  } finally {
    if (prior) Object.defineProperty(HTMLElement.prototype, 'onbeforematch', prior);
    else delete (HTMLElement.prototype as any).onbeforematch;
  }
});
