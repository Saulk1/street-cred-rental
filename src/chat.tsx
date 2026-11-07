import { useEffect, useRef, useState } from 'react';
import { ArrowUpIcon, CheckIcon, MapPinIcon, PlusIcon, RotateCcwIcon, SquareIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Message, MessageContent, MessageHeader, MessageFooter } from '@/components/ui/message';
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton } from '@/components/ui/message-scroller';
import { Trace, TraceLine, TraceIcon, TraceTitle } from '@/components/ui/trace';
import { Spinner } from '@/components/ui/spinner';
import { chatConfiguration, readThread, receiveChat } from '@/lib/chat';
import { CHAT_KEY, type ChatEvent, type ChatMessage } from '../shared/chat';

type Activity = Extract<ChatEvent, { type: 'tool' }>;

export function PropertyChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
    chrome.storage.local.get(CHAT_KEY).then(stored => {
      if (!alive.current) return;
      const thread = stored[CHAT_KEY] === undefined ? [] : readThread(stored[CHAT_KEY]);
      current.current = thread; hydrated.current = true; setMessages(thread); setLoaded(true);
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
    const prefix = retry ? current.current.slice(0, -1) : [...current.current,
      { id: crypto.randomUUID(), role: 'user' as const, content: draft.trim(), state: 'complete' as const, sources: [] }];
    if (prefix.at(-1)?.role !== 'user') return;
    const assistant: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', state: 'incomplete', sources: [] };
    update([...prefix, assistant].slice(-80), true);
    if (!retry) setDraft('');
    setError(''); setActivity([]); setBusy(true);
    const token = ++generation.current;
    const controller = new AbortController();
    request.current = controller;
    const active = () => alive.current && token === generation.current;
    try {
      await receiveChat(prefix, controller.signal, event => {
        if (!active()) return;
        if (event.type === 'tool') {
          setActivity(items => [...items.filter(item => item.id !== event.id), event]);
          return;
        }
        if (event.type === 'delta') assistant.content += event.text;
        if (event.type === 'source') assistant.sources.push(event.source);
        if (event.type === 'done') assistant.state = 'complete';
        update(current.current.map(m => m.id === assistant.id ? { ...assistant, sources: [...assistant.sources] } : m), event.type === 'done');
      });
    } catch (cause) {
      if (active() && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Chat could not be reached. Please retry.');
    } finally {
      if (active()) {
        request.current = null; setBusy(false); setActivity([]);
        update(current.current, true); editor.current?.focus();
      }
    }
  }
  function newChat() {
    generation.current++; request.current?.abort(); request.current = null;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    current.current = []; hydrated.current = true; setMessages([]); persist([], true);
    setDraft(''); setError(''); setStorageError(''); setBusy(false); setActivity([]); editor.current?.focus();
  }
  const retry = messages.at(-1)?.role === 'assistant' && messages.at(-1)?.state === 'incomplete';

  return <main className="chat-shell">
    <header className="chat-header"><div><p className="eyebrow">MICROBURBS FACTS</p><h1>Property assistant</h1></div>
      <Button variant="outline" disabled={!loaded} onClick={newChat}><PlusIcon data-icon="inline-start" aria-hidden="true" />New chat</Button></header>
    {!available && <Alert><AlertTitle>Chat is unavailable in this build</AlertTitle><AlertDescription>Your team needs to configure and rebuild the private extension to enable chat.</AlertDescription></Alert>}
    {storageError && <Alert variant="destructive"><AlertTitle>Chat storage</AlertTitle><AlertDescription>{storageError}</AlertDescription></Alert>}
    <section className="chat-thread" aria-label="Conversation" aria-busy={!loaded}>
      <MessageScrollerProvider autoScroll defaultScrollPosition="end"><MessageScroller>
        <MessageScrollerViewport><MessageScrollerContent className="p-4">
          {!messages.length && <MessageScrollerItem messageId="empty"><Empty><EmptyHeader><EmptyMedia variant="icon"><MapPinIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>{loaded ? 'What would you like to know?' : 'Loading your conversation…'}</EmptyTitle><EmptyDescription>Ask about an address in the City of Sydney. Explore property facts, estimates and the neighbourhood.</EmptyDescription></EmptyHeader></Empty></MessageScrollerItem>}
          {messages.map(message => <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === 'user'}>
            <Message align={message.role === 'user' ? 'end' : 'start'}><MessageContent>
              <MessageHeader>{message.role === 'user' ? 'You' : 'Microburbs'}</MessageHeader>
              {message.content && <Bubble variant={message.role === 'user' ? 'default' : 'secondary'} align={message.role === 'user' ? 'end' : 'start'}><BubbleContent><p className="whitespace-pre-wrap wrap-anywhere">{message.content}</p></BubbleContent></Bubble>}
              {message.id === messages.at(-1)?.id && busy && <Trace aria-label="Assistant activity">{activity.length ? activity.map(item => <TraceLine key={item.id} status={item.status === 'done' ? undefined : item.status}><TraceIcon>{item.status === 'running' ? <Spinner /> : <CheckIcon />}</TraceIcon><TraceTitle>{item.label}{item.status === 'done' ? ' · complete' : item.status === 'error' ? ' · unavailable' : '…'}</TraceTitle></TraceLine>) : <TraceLine status="running"><TraceIcon><Spinner /></TraceIcon><TraceTitle>Working on your answer…</TraceTitle></TraceLine>}</Trace>}
              {!!message.sources.length && <Trace aria-label="Property sources">{message.sources.map(s => <TraceLine key={s.id}><TraceIcon><MapPinIcon /></TraceIcon><TraceTitle>{s.id} · {s.label}</TraceTitle></TraceLine>)}</Trace>}
              {message.role === 'assistant' && message.state === 'incomplete' && !(busy && message.id === messages.at(-1)?.id) && <MessageFooter>Incomplete answer</MessageFooter>}
            </MessageContent></Message>
          </MessageScrollerItem>)}
        </MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton />
      </MessageScroller></MessageScrollerProvider>
    </section>
    <div role="status" aria-live="polite" className="chat-status">{busy ? 'Generating an answer.' : error || (retry ? 'Answer interrupted. You can retry or ask another question.' : '')}</div>
    {retry && !busy && <Button className="self-start" variant="outline" disabled={!available} onClick={() => void send(true)}><RotateCcwIcon data-icon="inline-start" />Retry answer</Button>}
    <form onSubmit={e => { e.preventDefault(); void send(); }}><FieldGroup><Field>
      <FieldLabel htmlFor="chat-message" className="sr-only">Message</FieldLabel>
      <InputGroup><InputGroupTextarea ref={editor} id="chat-message" name="message" maxLength={4000} rows={3} placeholder="Ask about a property…" value={draft} disabled={!loaded || !available} aria-describedby="chat-privacy" onChange={e => setDraft(e.target.value)} onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey) { if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return; e.preventDefault(); e.currentTarget.form?.requestSubmit(); }
      }} /><InputGroupAddon align="block-end" className="justify-between"><span className="text-xs">Shift + Enter for a new line</span>
        {busy ? <InputGroupButton size="sm" variant="outline" onClick={() => request.current?.abort()}><SquareIcon data-icon="inline-start" />Stop</InputGroupButton>
          : <InputGroupButton size="sm" variant="default" type="submit" disabled={!loaded || !available || !draft.trim()}><ArrowUpIcon data-icon="inline-start" />Send</InputGroupButton>}
      </InputGroupAddon></InputGroup>
    </Field></FieldGroup></form>
    <p id="chat-privacy" className="chat-privacy">Messages and requested property data are sent to your team’s backend and OpenAI. This chat is saved in this Chrome profile. Valuations are estimates.</p>
  </main>;
}
