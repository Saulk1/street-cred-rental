import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PropertyChat } from '../../extension/src/chat';
import { CHAT_KEY } from '../../shared/chat';
import { contextFor } from '../../extension/src/lib/chat';
import { calculation } from '../fixtures/calculation';

let stored: Record<string, any>;
let api: any;
const encoder = new TextEncoder();
const reply = (...events: object[]) => new Response(new ReadableStream({ start(c) {
  c.enqueue(encoder.encode(events.map(e => JSON.stringify(e)).join('\n') + '\n')); c.close();
} }), { headers: { 'Content-Type': 'application/x-ndjson' } });

beforeEach(() => {
  stored = {};
  api = { runtime: { getURL: (path: string) => path, getManifest: () => ({ host_permissions: ['https://chat.example.test/*'], content_security_policy: { extension_pages: 'connect-src https://chat.example.test' } }) },
    storage: { local: { get: vi.fn(async (key: string) => ({ [key]: structuredClone(stored[key]) })), set: vi.fn(async (items: object) => { Object.assign(stored, structuredClone(items)); }), remove: vi.fn(async (key: string) => { delete stored[key]; }) } } };
  vi.stubGlobal('chrome', api);
  vi.stubGlobal('CHAT_API_CONFIG', { baseUrl: 'https://chat.example.test', token: 'dummy-team-token' });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount() { const view = render(<PropertyChat />); await waitFor(() => expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled()); return view; }

it('sends, streams plain text safely, saves and restores one thread without reading notes', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(
    { type: 'tool', id: 'tool-1', label: 'Searching addresses', status: 'running' },
    { type: 'source', source: { id: 'S1', label: 'Address matches', path: '/v1/geocode/address' } },
    { type: 'delta', text: '<img src=x onerror=alert(1)>' }, { type: 'done' }));
  const user = userEvent.setup();
  const view = await mount();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), '26 Tudor Street');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('<img src=x onerror=alert(1)>');
  await waitFor(() => expect(stored[CHAT_KEY]?.at(-1).state).toBe('complete'));
  expect(document.querySelector('img[src="x"]')).toBeNull();
  expect(screen.getByAltText('Microburbs')).toBeVisible();
  expect(api.storage.local.get).toHaveBeenCalledWith(CHAT_KEY);
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ messages: [{ role: 'user', content: '26 Tudor Street' }] });
  expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer dummy-team-token' } });
  view.unmount(); await mount();
  expect(screen.getByText('26 Tudor Street')).toBeVisible();
  expect(screen.getByText('S1 · Address matches')).toBeVisible();
});

it('retries a failed answer without duplicating the question', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(reply({ type: 'delta', text: 'Please include the suburb.' }, { type: 'done' }));
  const user = userEvent.setup(); await mount();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Tudor Street{Enter}');
  await screen.findByText('Chat is not configured on the server yet.');
  await user.click(screen.getByRole('button', { name: 'Retry answer' }));
  await screen.findByText('Please include the suburb.');
  expect(screen.getAllByText('Tudor Street')).toHaveLength(1);
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).messages).toHaveLength(1);
});

it('stops an in-flight answer and New chat clears only the chat key', async () => {
  let cancelled = false;
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ start(c) {
    c.enqueue(encoder.encode('{"type":"delta","text":"Partial answer"}\n'));
  }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
  stored['note-keep'] = 'Keep this note';
  const user = userEvent.setup(); await mount();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Address{Enter}');
  await screen.findByText('Partial answer');
  await user.click(screen.getByRole('button', { name: 'Stop' }));
  await screen.findByText('Incomplete answer');
  expect(cancelled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'New chat' }));
  await waitFor(() => expect(stored[CHAT_KEY]).toBeUndefined());
  expect(stored['note-keep']).toBe('Keep this note');
  expect(screen.queryByText('Partial answer')).toBeNull();
});

it('does not submit while composing or with Shift+Enter, and submits ordinary Enter', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ type: 'delta', text: 'Hello' }, { type: 'done' }));
  await mount(); const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: '悉尼' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  await screen.findByText('Hello');
  expect(fetcher).toHaveBeenCalledOnce();
});

it('cancels New chat without allowing late replies to restore the cleared thread', async () => {
  let resolve: (value: Response) => void = () => {};
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(r => { resolve = r; }));
  const user = userEvent.setup(); await mount();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Address{Enter}');
  await user.click(screen.getByRole('button', { name: 'New chat' }));
  await act(async () => { resolve(reply({ type: 'delta', text: 'Late answer' }, { type: 'done' })); });
  expect(screen.queryByText('Late answer')).toBeNull();
  await waitFor(() => expect(stored[CHAT_KEY]).toBeUndefined());
});

it('shows an unavailable state with no request when the build has no chat token', async () => {
  vi.stubGlobal('CHAT_API_CONFIG', { baseUrl: 'https://chat.example.test', token: '' });
  const fetcher = vi.spyOn(globalThis, 'fetch'); await mount();
  expect(screen.getByText('Chat is unavailable in this build')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(fetcher).not.toHaveBeenCalled();
});

it('excludes incomplete replies and caps context without modifying the stored thread', () => {
  const thread = [
    { id: '1', role: 'user' as const, content: 'Question', state: 'complete' as const, sources: [] },
    { id: '2', role: 'assistant' as const, content: 'Unfinished', state: 'incomplete' as const, sources: [] },
    { id: '3', role: 'user' as const, content: 'Follow up', state: 'complete' as const, sources: [] },
  ];
  expect(contextFor(thread).map(m => m.content)).toEqual(['Question', 'Follow up']);
  expect(thread).toHaveLength(3);
});

it('does not overwrite a saved thread when closed before storage restoration finishes', async () => {
  let resolve: (value: object) => void = () => {};
  api.storage.local.get.mockImplementation(() => new Promise(r => { resolve = r; }));
  const view = render(<PropertyChat />);
  view.unmount();
  await act(async () => { resolve({ [CHAT_KEY]: [] }); });
  expect(api.storage.local.set).not.toHaveBeenCalled();
  expect(api.storage.local.remove).not.toHaveBeenCalled();
});

it('shows calculation metrics, inputs and limitations and preserves them across reopening', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(
    { type: 'source', source: { id: 'S1', label: 'Latest historical rent', path: '/v1/properties/GANSW1/rent-history-latest' } },
    { type: 'calculation', calculation }, { type: 'delta', text: 'The weekly difference is $30 [C1].' }, { type: 'done' }));
  const user = userEvent.setup(); const view = await mount();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), '$750 per week{Enter}');
  await user.click(await screen.findByRole('button', { name: 'C1 · Rent comparison' }));
  expect(screen.getByText('30 AUD/week')).toBeVisible();
  expect(screen.getByText(/You wrote: “\$750 per week”/)).toBeVisible();
  expect(screen.getByText('Historical asking rent; not a current rental valuation.')).toBeVisible();
  await waitFor(() => expect(stored[CHAT_KEY].at(-1).calculations).toEqual([calculation]));
  view.unmount(); await mount();
  const trigger = screen.getByRole('button', { name: 'C1 · Rent comparison' });
  trigger.focus(); await user.keyboard('{Enter}');
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('30 AUD/week')).toBeVisible();
});

it('streams rental questions, submits an option, restores the session and ends it on New chat', async () => {
  const { rentalQuestion, rentalRecommendation } = await import('../fixtures/rental');
  const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/api/chat')) return reply({type:'rental_result',rental:rentalQuestion},{type:'delta',text:'I have one rental question.'},{type:'done'});
    const command=JSON.parse(init!.body as string).command;
    return Response.json(command.operation==='end' ? {ended:true} : rentalRecommendation);
  });
  const user=userEvent.setup(); const view=await mount();
  await user.type(screen.getByRole('textbox',{name:'Message'}),'Find a rental under $800{Enter}');
  await screen.findByText('Do you need a pet-friendly home?');
  expect(within(screen.getByRole('region', { name:'Conversation messages' })).getByText('Do you need a pet-friendly home?')).toBeVisible();
  await user.click(screen.getByRole('radio',{name:'Yes, I have pets'}));
  await user.click(screen.getByRole('button',{name:'Apply answer'}));
  await screen.findByText('1 Example Street');
  expect(screen.queryByRole('button', {name:'Apply answer'})).toBeNull();
  const submitted=fetcher.mock.calls.find(([url])=>String(url).endsWith('/api/rental'))!;
  expect(JSON.parse(submitted[1]!.body as string)).toMatchObject({context:{revision:1},command:{operation:'answer',questionId:'q-001',optionId:'yes'}});
  expect(screen.getByText(/Price needs verification/)).toBeVisible();
  await waitFor(()=>expect(stored['property-rental:v1'].context.revision).toBe(2));
  view.unmount(); await mount();
  await screen.findByText('1 Example Street');
  await waitFor(()=>expect(fetcher.mock.calls.some(([,init])=>JSON.parse(init!.body as string).command?.operation==='resume')).toBe(true));
  await user.click(screen.getByRole('button',{name:'New chat'}));
  await waitFor(()=>expect(stored['property-rental:v1']).toBeUndefined());
  expect(fetcher.mock.calls.some(([,init])=>JSON.parse(init!.body as string).command?.operation==='end')).toBe(true);
});

it.each(['custom', 'skip'] as const)('advances to a new question after a %s answer and removes obsolete controls', async mode => {
  const { rentalQuestion } = await import('../fixtures/rental');
  const nextQuestion = { revision:2, result:{ ...rentalQuestion.result, question_id:'q-002',
    question_key:'needs.furnished', question_text:'Do you need furniture?',
    options:[{id:'yes',label:'Furnished please'}, {id:'skip',label:'Skip for now'}] } };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).endsWith('/api/chat')
    ? reply({type:'rental_result', rental:rentalQuestion}, {type:'delta',text:'Choose an option below.'}, {type:'done'})
    : Response.json(nextQuestion));
  const user = userEvent.setup(); await mount();
  await user.type(screen.getByRole('textbox', {name:'Message'}), 'Find rentals{Enter}');
  await screen.findByText(rentalQuestion.result.question_text!);
  if (mode === 'custom') await user.type(screen.getByRole('textbox', {name:'Or give a custom answer'}), 'I have a cat');
  else await user.click(screen.getByRole('radio', {name:'Skip for now'}));
  await user.click(screen.getByRole('button', {name:'Apply answer'}));
  await screen.findByText('Do you need furniture?');
  const request = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
  expect(request).toMatchObject({context:{revision:1}, command:{operation:'answer',questionId:'q-001',
    ...(mode === 'custom' ? {text:'I have a cat'} : {optionId:'skip'})}});
  expect(screen.queryByRole('radio', {name:'Yes, I have pets'})).toBeNull();
  expect(screen.getAllByRole('button', {name:'Apply answer'})).toHaveLength(1);
  expect(screen.getByRole('textbox', {name:'Or give a custom answer'})).toHaveValue('');
});

it('restores a pending question in place and accepts an answer after reopening', async () => {
  const { rentalQuestion, rentalRecommendation } = await import('../fixtures/rental');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/api/chat')) return reply({type:'rental_result',rental:rentalQuestion}, {type:'done'});
    const command = JSON.parse(init!.body as string).command;
    return Response.json(command.operation === 'resume' ? {...rentalQuestion,revision:2} : {...rentalRecommendation,revision:3});
  });
  const user = userEvent.setup(); const view = await mount();
  await user.type(screen.getByRole('textbox', {name:'Message'}), 'Find rentals{Enter}');
  await screen.findByText(rentalQuestion.result.question_text!);
  await waitFor(() => expect(stored[CHAT_KEY].at(-1).state).toBe('complete'));
  const originalMessageId = stored[CHAT_KEY].at(-1).id;
  view.unmount(); await mount();
  await waitFor(() => expect(stored['property-rental:v1'].context.revision).toBe(2));
  expect(stored[CHAT_KEY]).toHaveLength(2);
  expect(stored[CHAT_KEY].at(-1).id).toBe(originalMessageId);
  expect(screen.getAllByText(rentalQuestion.result.question_text!)).toHaveLength(1);
  await user.click(screen.getByRole('radio', {name:'Yes, I have pets'}));
  await user.click(screen.getByRole('button', {name:'Apply answer'}));
  await screen.findByText('1 Example Street');
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string)).toMatchObject({context:{revision:2},command:{questionId:'q-001'}});
});
