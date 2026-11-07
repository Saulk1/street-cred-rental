import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, MapPinIcon, PlusIcon, RotateCcwIcon, SquareIcon } from 'lucide-react';
import { FactsBrand } from '@/components/facts-brand';
import { chatConfiguration, readThread, receiveChat } from '@/lib/chat';
import { CalculationTrace } from '@/components/calculation-trace';
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
  const thread = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const available = !!chatConfiguration();

  useLayoutEffect(() => {
    if (follow.current && thread.current) thread.current.scrollTop = messages.length ? thread.current.scrollHeight : 0;
  }, [messages, activity, loaded, busy]);

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
    follow.current = true; setShowLatest(false);
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
      await receiveChat(prefix, controller.signal, event => {
        if (!active()) return;
        if (event.type === 'tool') {
          setActivity(items => [...items.filter(item => item.id !== event.id), event]);
          return;
        }
        if (event.type === 'delta') assistant.content += event.text;
        if (event.type === 'source') assistant.sources.push(event.source);
        if (event.type === 'calculation') assistant.calculations!.push(event.calculation);
        if (event.type === 'done') assistant.state = 'complete';
        update(current.current.map(m => m.id === assistant.id ? { ...assistant, sources: [...assistant.sources], calculations: [...assistant.calculations!] } : m), event.type === 'done');
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
    follow.current = true; setShowLatest(false);
  }
  const retry = messages.at(-1)?.role === 'assistant' && messages.at(-1)?.state === 'incomplete';

  return <main className="chat-shell">
    <header className="chat-header"><div><FactsBrand /><p className="chat-tagline">A little local knowledge.</p></div><button className="popup-button" disabled={!loaded} onClick={newChat}><PlusIcon aria-hidden="true" />New chat</button></header>
    <section className="chat-intro"><div><p className="overview-eyebrow">Your property companion</p><h1>Property assistant</h1><p>From an address to a clearer local picture.</p></div><span className="chat-coverage"><MapPinIcon aria-hidden="true" />City of Sydney</span></section>
    {!available && <aside className="chat-notice"><h2>Chat is unavailable in this build</h2><p>Your team needs to configure and rebuild the private extension to enable chat.</p></aside>}
    {storageError && <aside className="chat-notice error" role="alert"><h2>Chat storage</h2><p>{storageError}</p></aside>}
    <section className="chat-card" aria-label="Conversation" aria-busy={!loaded}><header className="chat-card-heading"><h2>Your conversation</h2><span>Property facts · Local context</span></header>
      <div ref={thread} className="chat-thread" role="region" tabIndex={0} aria-label="Conversation messages" onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; setShowLatest(messages.length > 0 && !follow.current); }}>
        {!messages.length && <div className="chat-empty"><span className="chat-empty-icon"><MapPinIcon aria-hidden="true" /></span><h3>{loaded ? 'What would you like to know?' : 'Loading your conversation…'}</h3><p>Ask about an address in the City of Sydney. Explore property facts, estimates and the neighbourhood.</p><div className="chat-topics"><span>Property facts</span><span>Prices &amp; history</span><span>Neighbourhood</span></div></div>}
        <ol className="chat-messages">{messages.map(message => <li key={message.id} className="chat-message" data-author={message.role}><article><header>{message.role === 'user' ? 'You' : 'Microburbs'}</header>
          {message.content && <p className="chat-message-text">{message.content}</p>}
          {message.id === messages.at(-1)?.id && busy && <ul className="chat-activity" aria-label="Assistant activity">{activity.length ? activity.map(item => <li key={item.id} data-state={item.status}>{item.status === 'running' ? <span className="native-spinner" aria-hidden="true" /> : <CheckIcon aria-hidden="true" />}<span>{item.label}{item.status === 'done' ? ' · complete' : item.status === 'error' ? ' · unavailable' : '…'}</span></li>) : <li><span className="native-spinner" aria-hidden="true" /><span>Working on your answer…</span></li>}</ul>}
          {!!message.sources.length && <ul className="chat-sources" aria-label="Property sources">{message.sources.map(source => <li key={source.id}><MapPinIcon aria-hidden="true" /><span>{source.id} · {source.label}</span></li>)}</ul>}
          {!!message.calculations?.length && <CalculationTrace calculations={message.calculations} />}
          {message.role === 'assistant' && message.state === 'incomplete' && !(busy && message.id === messages.at(-1)?.id) && <footer>Incomplete answer</footer>}
        </article></li>)}</ol>
      </div>
      {showLatest && <button className="chat-jump" onClick={() => { follow.current = true; setShowLatest(false); if (thread.current) thread.current.scrollTop = thread.current.scrollHeight; }}><ArrowDownIcon aria-hidden="true" />Latest messages</button>}
    </section>
    <div role="status" aria-live="polite" className="chat-status">{busy ? 'Generating an answer.' : error || (retry ? 'Answer interrupted. You can retry or ask another question.' : '')}</div>
    {retry && !busy && <button className="popup-button chat-retry" disabled={!available} onClick={() => void send(true)}><RotateCcwIcon aria-hidden="true" />Retry answer</button>}
    <form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="chat-message" className="popup-sr-only">Message</label><textarea ref={editor} id="chat-message" name="message" maxLength={4000} rows={3} placeholder="Ask about a property…" value={draft} disabled={!loaded || !available} aria-describedby="chat-privacy chat-keyboard-hint" onChange={event => setDraft(event.target.value)} onKeyDown={event => {
      if (event.key === 'Enter' && !event.shiftKey) { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
    }} /><footer><span id="chat-keyboard-hint">Shift + Enter for a new line</span>{busy ? <button type="button" className="popup-button" onClick={() => request.current?.abort()}><SquareIcon aria-hidden="true" />Stop</button> : <button className="popup-button primary" type="submit" disabled={!loaded || !available || !draft.trim()}><ArrowUpIcon aria-hidden="true" />Send</button>}</footer></form>
    <p id="chat-privacy" className="chat-privacy">Messages and requested property data are sent to your team’s backend and OpenAI. This chat is saved in this Chrome profile. Valuations are estimates.</p>
  </main>;
}
