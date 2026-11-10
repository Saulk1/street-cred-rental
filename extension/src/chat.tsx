import { RentalAdvisorPanel } from '@/components/rental-advisor';
import { newRentalContext, rentalRequest, RENTAL_KEY } from '@/lib/chat';
import { validRentalContext, type RentalReply, type RentalCommand } from '../../shared/rental';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpIcon, CheckIcon, MapPinIcon, PlusIcon, RotateCcwIcon, SquareIcon } from 'lucide-react';
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton, useMessageScroller } from '@/components/ui/message-scroller';
import { Message, MessageContent, MessageHeader, MessageFooter } from '@/components/ui/message';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Trace, TraceLine, TraceIcon, TraceTitle } from '@/components/ui/trace';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { FactsBrand } from '@/components/facts-brand';
import { SydneyBackdrop } from '@/components/sydney-backdrop';
import { chatConfiguration, readThread, receiveChat } from '@/lib/chat';
import { CalculationTrace } from '@/components/calculation-trace';
import { CHAT_KEY, type ChatEvent, type ChatMessage } from '../../shared/chat';

type Activity = Extract<ChatEvent, { type: 'tool' }>;

/** Examples of what the assistant can do. Address examples end mid-sentence so the user supplies the address. */
const STARTERS = [
  { label: 'Find a one-bedroom rental under $800 a week near UTS', text: 'Find a one-bedroom rental under $800 a week near UTS' },
  { label: 'Tell me about the property at…', text: 'Tell me about the property at ' },
  { label: 'What are the flood, bushfire and heritage risks at…', text: 'What are the flood, bushfire and heritage risks at ' },
];

export function PropertyChat() {
  return <MessageScrollerProvider autoScroll defaultScrollPosition="end"><PropertyChatSession /></MessageScrollerProvider>;
}

function PropertyChatSession() {
  const { scrollToEnd } = useMessageScroller();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const rental = useRef(newRentalContext());
  const lastAction = useRef<{ eventId: string; command: RentalCommand } | null>(null);
  const current = useRef<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [activity, setActivity] = useState<Activity[]>([]);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const hydrated = useRef(false);
  const queue = useRef(Promise.resolve());
  const rentalQueue = useRef(Promise.resolve());
  function saveRental(value: unknown) {
    rentalQueue.current = rentalQueue.current.catch(() => {}).then(() => value === null ? chrome.storage.local.remove(RENTAL_KEY) : chrome.storage.local.set({ [RENTAL_KEY]: structuredClone(value) }));
    return rentalQueue.current;
  }
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const available = !!chatConfiguration();

  function persist(next: ChatMessage[], remove = false) {
    const snapshot = structuredClone(next);
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (remove) await chrome.storage.local.remove(CHAT_KEY);
      else await chrome.storage.local.set({ [CHAT_KEY]: snapshot });
    }).catch(() => { if (alive.current) setStorageError('This conversation could not be saved. Keep this tab open and try again.'); });
  }
  function update(next: ChatMessage[], immediate = false) {
    hydrated.current = true;
    current.current = next;
    setMessages(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (immediate) persist(next);
    else saveTimer.current = setTimeout(() => persist(current.current), 200);
  }
  useEffect(() => {
    alive.current = true;
    chrome.storage.local.get(CHAT_KEY).then(async stored => {
      const saved: Record<string, any> = await chrome.storage.local.get(RENTAL_KEY);
      if (validRentalContext(saved[RENTAL_KEY]?.context)) rental.current = saved[RENTAL_KEY].context;
      lastAction.current = saved[RENTAL_KEY]?.pending ?? null;
      if (!alive.current) return;
      const thread = stored[CHAT_KEY] === undefined ? [] : readThread(stored[CHAT_KEY]);
      current.current = thread; hydrated.current = true; setMessages(thread); setLoaded(true);
      if (rental.current.revision > 0 && available) void actRental(lastAction.current?.command ?? { operation: 'resume' });
    }).catch(() => {
      if (alive.current) { setStorageError('Saved chat could not be loaded. Choose New chat to start again.'); setLoaded(true); }
    });
    const leave = () => {
      request.current?.abort();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (hydrated.current) persist(current.current);
    };
    window.addEventListener('pagehide', leave);
    return () => { alive.current = false; generation.current++; window.removeEventListener('pagehide', leave); leave(); };
  }, []);

  async function send(retry = false) {
    if (request.current || !loaded || !available || (!retry && !draft.trim())) return;
    scrollToEnd({ behavior: 'instant' });
    const prefix = retry ? current.current.slice(0, -1) : [...current.current,
      { id: crypto.randomUUID(), role: 'user' as const, content: draft.trim(), state: 'complete' as const, sources: [] }];
    if (prefix.at(-1)?.role !== 'user') return;
    const assistant: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', state: 'incomplete', sources: [], calculations: [] };
    update([...prefix, assistant].slice(-80), true);
    if (!retry) setDraft('');
    setError(''); setActivity([]); setBusy(true);
    const token = ++generation.current;
    const controller = new AbortController();
    request.current = controller;
    const active = () => alive.current && token === generation.current;
    try {
      await saveRental({ context: rental.current });
      await receiveChat(prefix, controller.signal, event => {
        if (!active()) return;
        if (event.type === 'tool') {
          setActivity(items => [...items.filter(item => item.id !== event.id), event]);
          return;
        }
        if (event.type === 'delta') assistant.content += event.text;
        if (event.type === 'source') assistant.sources.push(event.source);
        if (event.type === 'calculation') assistant.calculations!.push(event.calculation);
        if (event.type === 'rental_result') { assistant.rental = event.rental; acceptRental(event.rental); }
        if (event.type === 'done') assistant.state = 'complete';
        update(current.current.map(m => m.id === assistant.id ? { ...assistant, sources: [...assistant.sources], calculations: [...assistant.calculations!] } : m), event.type === 'done');
      }, rental.current);
    } catch (cause) {
      if (active() && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Chat could not be reached. Please retry.');
    } finally {
      if (active()) {
        request.current = null; setBusy(false); setActivity([]);
        update(current.current, true); editor.current?.focus();
      }
    }
  }
  function acceptRental(reply: RentalReply) {
    rental.current = { ...rental.current, revision: reply.revision };
    lastAction.current = null;
    void saveRental({ context: rental.current }).catch(() => setStorageError('Rental session could not be saved.'));
  }
  async function actRental(command: RentalCommand) {
    if (request.current) return;
    if (command.operation !== 'resume') scrollToEnd({ behavior: 'instant' });
    const controller = new AbortController(); request.current = controller; setBusy(true); setError('');
    const epoch = generation.current;
    const pending = lastAction.current && JSON.stringify(lastAction.current.command) === JSON.stringify(command) ? lastAction.current : { eventId: crypto.randomUUID(), command };
    lastAction.current = pending;
    try {
      await saveRental({ context: rental.current, pending });
      const reply = await rentalRequest(rental.current, command, controller.signal, pending.eventId);
      if (alive.current && epoch === generation.current && 'result' in reply) {
        acceptRental(reply);
        const previous = [...current.current].reverse().find(m => m.role === 'assistant' && m.rental);
        if (command.operation === 'resume' && previous) {
          update(current.current.map(m => m.id === previous.id ? { ...m, rental: reply } : m), true);
        } else {
          const assistant: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: reply.result.action === 'ask' ? reply.result.question_text! : 'Rental search updated.', state: 'complete', sources: [], rental: reply };
          update([...current.current, assistant].slice(-80), true);
        }
      }
    } catch (cause) { if (alive.current && epoch === generation.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Rental planning failed.'); }
    finally { if (epoch === generation.current) { request.current = null; setBusy(false); } }
  }
  function newChat() {
    if (rental.current.revision > 0) void rentalRequest(rental.current, { operation: 'end' }).catch(() => {});
    rental.current = newRentalContext(); lastAction.current = null;
    void saveRental(null).catch(() => setStorageError('Rental session could not be cleared.'));
    generation.current++; request.current?.abort(); request.current = null;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    current.current = []; hydrated.current = true; setMessages([]); persist([], true);
    setDraft(''); setError(''); setStorageError(''); setBusy(false); setActivity([]); editor.current?.focus();
  }
  /** Puts an example into the composer for the user to finish and send; nothing is sent until they do. */
  function startWith(text: string) {
    setDraft(text);
    requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(text.length, text.length); });
  }
  const retry = messages.at(-1)?.role === 'assistant' && messages.at(-1)?.state === 'incomplete';
  const latestRentalId = [...messages].reverse().find(m => m.role === 'assistant' && m.rental)?.id;

  return <main className="chat-shell chat-glass">
    <SydneyBackdrop />
    <header className="chat-header"><div><FactsBrand /><p className="chat-tagline">A little local knowledge.</p></div><button className="popup-button" disabled={!loaded} onClick={newChat}><PlusIcon aria-hidden="true" />New chat</button></header>
    <section className="chat-intro"><div><h1>Property assistant</h1><p>Look up an address, or describe the rental you want.</p></div><span className="chat-coverage"><MapPinIcon aria-hidden="true" />City of Sydney</span></section>
    {!available && <aside className="chat-notice"><h2>Chat is unavailable in this build</h2><p>Your team needs to configure and rebuild the private extension to enable chat.</p></aside>}
    {storageError && <aside className="chat-notice error" role="alert"><h2>Chat storage</h2><p>{storageError}</p></aside>}
    <section className="chat-card" aria-label="Conversation" aria-busy={!loaded}><header className="chat-card-heading"><h2>Your conversation</h2></header>
      <MessageScroller className="flex-1"><MessageScrollerViewport className="chat-thread" aria-label="Conversation messages"><MessageScrollerContent className="pb-14">
        {!messages.length && <MessageScrollerItem messageId="chat-empty">
          <Empty>
            <EmptyHeader><EmptyMedia variant="icon"><MapPinIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle role="heading" aria-level={3}>{loaded ? 'What would you like to know?' : 'Loading your conversation…'}</EmptyTitle>
              <EmptyDescription>Ask about an address in the City of Sydney, or say what you need in a rental and the advisor will compare homes for you.</EmptyDescription></EmptyHeader>
            {loaded && available && <EmptyContent><ul aria-label="Example questions" className="flex w-full list-none flex-col gap-2 p-0">
              {STARTERS.map(starter => <li key={starter.text}><Button variant="outline" className="h-auto w-full justify-start py-2 text-start whitespace-normal" onClick={() => startWith(starter.text)}>{starter.label}</Button></li>)}
            </ul></EmptyContent>}
          </Empty>
        </MessageScrollerItem>}
        {messages.map(message => <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === 'user'}>
          <Message align={message.role === 'user' ? 'end' : 'start'}><MessageContent>
          <MessageHeader>{message.role === 'user' ? 'You' : 'Microburbs'}</MessageHeader>
          {message.content && !(message.id === latestRentalId && message.content === message.rental?.result.question_text) && <Bubble variant={message.role === 'user' ? 'secondary' : 'muted'} align={message.role === 'user' ? 'end' : 'start'}><BubbleContent><p className="chat-message-text">{message.content}</p></BubbleContent></Bubble>}
          {message.rental?.result.action === 'ask' && message.id !== latestRentalId && !message.content.includes(message.rental.result.question_text!) && <Bubble variant="muted"><BubbleContent>{message.rental.result.question_text}</BubbleContent></Bubble>}
          {message.id === messages.at(-1)?.id && busy && <Trace aria-label="Assistant activity">{activity.length ? activity.map(item => <TraceLine key={item.id} status={item.status === 'done' ? undefined : item.status}><TraceIcon>{item.status === 'running' ? <Spinner /> : <CheckIcon />}</TraceIcon><TraceTitle>{item.label}{item.status === 'done' ? ' · complete' : item.status === 'error' ? ' · unavailable' : '…'}</TraceTitle></TraceLine>) : <TraceLine status="running"><TraceIcon><Spinner /></TraceIcon><TraceTitle>Working on your answer…</TraceTitle></TraceLine>}</Trace>}
          {!!message.sources.length && <ul className="chat-sources" aria-label="Property sources">{message.sources.map(source => <li key={source.id}><MapPinIcon aria-hidden="true" /><span>{source.id} · {source.label}</span></li>)}</ul>}
          {!!message.calculations?.length && <CalculationTrace calculations={message.calculations} />}
          {message.rental && message.id === latestRentalId && <RentalAdvisorPanel key={`${message.rental.revision}-${message.rental.result.question_id ?? 'recommend'}`} reply={message.rental} busy={busy || !available} act={command => void actRental(command)} />}
          {message.role === 'assistant' && message.state === 'incomplete' && !(busy && message.id === messages.at(-1)?.id) && <MessageFooter>Incomplete answer</MessageFooter>}
          </MessageContent></Message>
        </MessageScrollerItem>)}
      </MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton aria-label="Latest messages" /></MessageScroller>
    </section>
    <div role="status" aria-live="polite" className="chat-status">{busy ? 'Generating an answer.' : error || (retry ? 'Answer interrupted. You can retry or ask another question.' : '')}</div>
    {retry && !busy && <button className="popup-button chat-retry" disabled={!available} onClick={() => void send(true)}><RotateCcwIcon aria-hidden="true" />Retry answer</button>}
    <form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="chat-message" className="popup-sr-only">Message</label><textarea ref={editor} id="chat-message" name="message" maxLength={4000} rows={3} placeholder="Ask about a property or a rental…" value={draft} disabled={!loaded || !available} aria-describedby="chat-privacy chat-keyboard-hint" onChange={event => setDraft(event.target.value)} onKeyDown={event => {
      if (event.key === 'Enter' && !event.shiftKey) { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
    }} /><footer><span id="chat-keyboard-hint">Shift + Enter for a new line</span>{busy ? <button type="button" className="popup-button" onClick={() => request.current?.abort()}><SquareIcon aria-hidden="true" />Stop</button> : <button className="popup-button primary" type="submit" disabled={!loaded || !available || !draft.trim()}><ArrowUpIcon aria-hidden="true" />Send</button>}</footer></form>
    <p id="chat-privacy" className="chat-privacy">Messages and requested property data are sent to your team’s backend and OpenAI. This chat is saved in this Chrome profile. Anonymous rental preferences are stored on the backend; the rental session expires after 30 minutes of inactivity. Rental listings come from a dated snapshot; estimates and availability need confirmation.</p>
  </main>;
}
