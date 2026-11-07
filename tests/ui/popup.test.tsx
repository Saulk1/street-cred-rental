import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Popup } from '../../src/popup';
import { readNotes } from '../../src/types';

let stored: Record<string, unknown>;
let changes: ((values: Record<string, unknown>, area: string) => void)[];
let api: any;
beforeEach(() => {
  stored = {}; changes = [];
  api = { runtime: { getURL: (s: string) => s, openOptionsPage: vi.fn(async () => {}) }, windows: { getCurrent: vi.fn(async () => ({ id: 7 })) }, sidePanel: { open: vi.fn(async () => {}) }, tabs: { query: vi.fn(async () => [{ id: 42 }]), sendMessage: vi.fn(async () => ({ ok: true })) }, storage: { local: { get: vi.fn(async () => structuredClone(stored)), set: vi.fn(async (items: object) => { Object.assign(stored, items); changes.forEach(c => c(items, 'local')); }), remove: vi.fn(async (key: string) => { delete stored[key]; changes.forEach(c => c({ [key]: {} }, 'local')); }) }, onChanged: { addListener: (fn: any) => changes.push(fn), removeListener: (fn: any) => { changes = changes.filter(c => c !== fn); } } } };
  vi.stubGlobal('chrome', api);
});
async function mount() { const user = userEvent.setup(); const view = render(<Popup />); await user.click(screen.getByRole('button', { name: /^Notes/ })); await screen.findByText('No saved notes yet'); return { user, ...view }; }
const put = (id: string, text: string, createdAt = 1, type = 'manual') => stored['microburbs.note.' + id] = { id, text, createdAt, type };
it('dispatches side panel immediately in the gesture; options/widget actions report failures and retry', async () => {
  const { user } = await mount();
  const button = screen.getByRole('button', { name: 'Side panel' });
  fireEvent.click(button);
  expect(api.sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
  await screen.findByText('Side panel opened.');
  api.runtime.openOptionsPage.mockRejectedValueOnce(new Error());
  await user.click(screen.getByRole('button', { name: 'Open options' }));
  expect(screen.getByRole('status')).toHaveTextContent('Could not open options');
  await user.click(screen.getByRole('button', { name: 'Open options' }));
  expect(screen.getByRole('status')).toHaveTextContent('Options opened.');
  api.tabs.sendMessage.mockResolvedValueOnce({ ok: false });
  await user.click(screen.getByRole('button', { name: 'Page widget' }));
  expect(screen.getByRole('status')).toHaveTextContent('Open a regular web page');
  await user.click(screen.getByRole('button', { name: 'Page widget' }));
  expect(api.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'SHOW_WIDGET' }, { frameId: 0 });
});
it('saves literal multiline Unicode, preserves it across remount and deletes with focus recovery', async () => {
  const { user, unmount } = await mount();
  const text = '<script>alert(1)</script>\n悉尼 🏡';
  fireEvent.change(screen.getByLabelText(/New note/), { target: { value: text } });
  await user.click(screen.getByRole('button', { name: 'Save note' }));
  expect(Object.values(stored)[0]).toMatchObject({ text, type: 'manual' });
  expect(document.querySelector('script')).toBeNull();
  unmount(); render(<Popup />); await user.click(screen.getByRole('button', { name: /^Notes/ }));
  const remove = await screen.findByRole('button', { name: /Delete note:/ });
  remove.focus(); await user.keyboard('{Enter}');
  await screen.findByText('No saved notes yet');
  expect(screen.getByLabelText(/New note/)).toHaveFocus();
});
it('blocks whitespace, preserves draft on failed save and text typed while saving', async () => {
  const { user } = await mount(); const editor = screen.getByLabelText(/New note/);
  fireEvent.change(editor, { target: { value: '   ' } }); fireEvent.submit(document.querySelector('form')!);
  expect(api.storage.local.set).not.toHaveBeenCalled();
  expect(editor).toHaveAttribute('aria-invalid', 'true');
  fireEvent.change(editor, { target: { value: 'first draft' } });
  api.storage.local.set.mockRejectedValueOnce(new Error());
  await user.click(screen.getByRole('button', { name: 'Save note' }));
  expect(editor).toHaveValue('first draft');
  let finish!: () => void; api.storage.local.set.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  fireEvent.submit(document.querySelector('form')!);
  fireEvent.submit(document.querySelector('form')!);
  expect(api.storage.local.set).toHaveBeenCalledTimes(2);
  fireEvent.change(editor, { target: { value: 'second draft' } });
  await act(async () => finish());
  expect(editor).toHaveValue('second draft');
});
it('keeps failed deletes, refreshes external updates and ignores stale reads', async () => {
  const { user } = await mount();
  put('one', 'Old note'); await act(async () => changes.forEach(c => c({ 'microburbs.note.one': {} }, 'local')));
  api.storage.local.remove.mockRejectedValueOnce(new Error());
  await user.click(screen.getByRole('button', { name: /Delete note: Old note/ }));
  expect(screen.getByText('Old note')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Could not delete');
  let finish!: (value: object) => void;
  api.storage.local.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => changes.forEach(c => c({ 'microburbs.note.one': {} }, 'local')));
  put('two', 'Newest', 2); await act(async () => changes.forEach(c => c({ 'microburbs.note.two': {} }, 'local')));
  await act(async () => finish({}));
  expect(screen.getByText('Newest')).toBeVisible();
});
it('retains valid legacy notes, ordering and rejects malformed stored values', () => {
  put('a', 'A', 1, 'url'); put('b', 'B', 3); stored['microburbs.note.invalid'] = { id: 'different' }; stored.other = {};
  expect(readNotes(stored).map(n => n.text)).toEqual(['B', 'A']);
});
it('removes subscriptions after closing', async () => { const { unmount } = await mount(); expect(changes).toHaveLength(2); unmount(); expect(changes).toHaveLength(0); });
it('shows initial storage failure without claiming the notepad is empty', async () => {
  api.storage.local.get.mockRejectedValueOnce(new Error()); render(<Popup />);
  await userEvent.setup().click(screen.getByRole('button', { name: /^Notes/ }));
  expect(await screen.findByText('Saved notes could not be loaded')).toBeVisible();
  expect(screen.queryByText('No saved notes yet')).toBeNull();
});
it('preserves another context’s save while a deletion is pending', async () => {
  const { user } = await mount(); put('one', 'Delete this one');
  await act(async () => changes.forEach(c => c({ 'microburbs.note.one': {} }, 'local')));
  let finish!: () => void;
  api.storage.local.remove.mockImplementationOnce(() => new Promise<void>(resolve => { finish = () => { delete stored['microburbs.note.one']; resolve(); }; }));
  await user.click(screen.getByRole('button', { name: /Delete note: Delete this one/ }));
  put('two', 'Saved elsewhere', 2);
  await act(async () => changes.forEach(c => c({ 'microburbs.note.two': {} }, 'local')));
  expect(screen.getByRole('button', { name: /Delete note: Delete this one/ })).toHaveAttribute('aria-disabled', 'true');
  await act(async () => finish()); expect(screen.getByText('Saved elsewhere')).toBeVisible();
  expect(screen.queryByText('Delete this one')).toBeNull();
});

it('uses the supplied wordmark and official social links', async () => {
  await mount();
  expect(screen.getByAltText('Microburbs')).toHaveAttribute('src', 'assets/2b3d1c2b0be2d1ac87bf7a95fac33e3a.webp');
  expect(screen.getByRole('link', { name: /Microburbs on Instagram/ })).toHaveAttribute('href', 'https://www.instagram.com/microburbs/');
  expect(screen.getByRole('link', { name: /Microburbs on YouTube/ })).toHaveAttribute('href', 'https://www.youtube.com/channel/UCUollIZedjqNspdu5CjIwBw');
  expect(screen.getByRole('link', { name: /Microburbs on Facebook/ })).toHaveAttribute('rel', 'noopener noreferrer');
});
