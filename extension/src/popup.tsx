import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Settings2Icon, PanelRightIcon, MousePointer2Icon, PlusIcon, Trash2Icon, NotebookPenIcon, LockKeyholeIcon, ArrowLeftIcon } from 'lucide-react';
import { PopupSocial } from '@/components/popup-social';
import { PropertyReport } from '@/property-report';
import { NOTE_PREFIX, readNotes, type Note, type Candidate } from '@/types';

export function Popup() {
  const [tab, setTab] = useState('property');
  const [windowId, setWindowId] = useState<number>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const hasLoaded = useRef(false);
  const [status, setStatus] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [deleting, setDeleting] = useState(new Set<string>());
  const pending = useRef(new Set<string>());
  const savingRef = useRef(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const version = useRef(0);
  const alive = useRef(true);
  const focusAfterLoad = useRef<{ id?: string; index: number } | null>(null);
  const reload = useRef<() => Promise<void>>(async () => {});
  useEffect(() => { document.title = `${tab === 'property' ? 'Property' : 'Notes'} | Microburbs Facts`; }, [tab]);
  useEffect(() => {
    alive.current = true;
    chrome.windows.getCurrent().then(w => {
      if (!Number.isInteger(w.id)) throw new Error();
      if (alive.current) setWindowId(w.id);
    }).catch(() => { if (alive.current) setStatus('Could not find this browser window. Reopen the popup to try again.'); });
    reload.current = async () => {
      const token = ++version.current;
      try {
        const stored = await chrome.storage.local.get(null);
        if (!alive.current || token !== version.current) return;
        const values = readNotes(stored);
        const focused = list.current?.querySelectorAll<HTMLButtonElement>('button');
        const index = focused ? [...focused].indexOf(document.activeElement as HTMLButtonElement) : -1;
        if (index >= 0) focusAfterLoad.current = { id: (document.activeElement as HTMLButtonElement).dataset.noteId, index };
        setNotes(values); setLoaded(true); setLoadError(false); hasLoaded.current = true;
      } catch { if (alive.current && token === version.current) { setLoaded(true); if (!hasLoaded.current) setLoadError(true); setStatus('Could not load notes. Reopen the popup to try again.'); } }
    };
    const changed = (changes: Record<string, unknown>, area: string) => { if (area === 'local' && Object.keys(changes).some(k => k.startsWith(NOTE_PREFIX))) void reload.current(); };
    chrome.storage.onChanged.addListener(changed);
    void reload.current();
    return () => { alive.current = false; version.current++; chrome.storage.onChanged.removeListener(changed); };
  }, []);
  useLayoutEffect(() => {
    const target = focusAfterLoad.current;
    if (!target) return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    (buttons.find(b => b.dataset.noteId === target.id) ?? buttons[Math.min(target.index, buttons.length - 1)] ?? editor.current)?.focus({ preventScroll: true });
    focusAfterLoad.current = null;
  }, [notes]);
  async function action(run: () => Promise<unknown>, success: string, error: string) {
    setStatus('');
    try { await run(); if (alive.current) setStatus(success); } catch { if (alive.current) setStatus(error); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    if (!draft.trim()) { setInvalid(true); editor.current?.setCustomValidity('Enter a note before saving.'); editor.current?.reportValidity(); return; }
    const text = draft;
    savingRef.current = true; setSaving(true); setStatus('');
    try {
      const id = crypto.randomUUID();
      await chrome.storage.local.set({ [NOTE_PREFIX + id]: { id, text, createdAt: Date.now(), type: 'manual' } });
      if (!alive.current) return;
      setDraft(current => current === text ? '' : current); setStatus('Note saved.'); await reload.current();
    } catch { if (alive.current) setStatus('Could not save the note. Your text is still here; please try again.'); }
    finally { savingRef.current = false; if (alive.current) setSaving(false); }
  }
  async function remove(id: string) {
    if (pending.current.has(id)) return;
    pending.current.add(id); setDeleting(new Set(pending.current)); setStatus('');
    try { await chrome.storage.local.remove(NOTE_PREFIX + id); if (alive.current) { setStatus('Note deleted.'); await reload.current(); } }
    catch { if (alive.current) setStatus('Could not delete the note. Please try again.'); }
    finally { pending.current.delete(id); if (alive.current) setDeleting(new Set(pending.current)); }
  }
  async function saveProperty(candidate: Candidate) {
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [NOTE_PREFIX + id]: { id, text: candidate.label, createdAt: Date.now(), type: 'manual' } });
    if (alive.current) await reload.current();
  }
  return <main className="popup-shell">
    <header className="popup-header"><div className="popup-brand"><img src={chrome.runtime.getURL('assets/2b3d1c2b0be2d1ac87bf7a95fac33e3a.webp')} width="162" height="36" alt="Microburbs" /><span className="popup-brand-divider" aria-hidden="true" /><span className="popup-brand-facts">Facts</span><span className="popup-beta">Beta</span></div><nav className="popup-tools" aria-label="Extension tools">
      <button id="open-side-panel" className="popup-icon-button" aria-label="Side panel" disabled={windowId === undefined} onClick={() => void action(() => chrome.sidePanel.open({ windowId: windowId! }), 'Side panel opened.', 'Could not open the side panel. Try again in Chrome 116 or newer.')}><PanelRightIcon aria-hidden="true" /></button>
      <button id="open-options" className="popup-icon-button" aria-label="Open options" onClick={() => void action(() => chrome.runtime.openOptionsPage(), 'Options opened.', 'Could not open options. Please try again.')}><Settings2Icon aria-hidden="true" /></button>
    </nav><p className="popup-tagline">A little local knowledge.</p></header>
    <section hidden={tab !== 'property'} aria-label="Property research"><PropertyReport onSave={saveProperty} /></section>
    <section hidden={tab !== 'notes'} aria-label="Your notes" className="overview-stack">
      <button className="popup-link" onClick={() => setTab('property')}><ArrowLeftIcon aria-hidden="true" />Back to property</button>
      <article className="overview-card"><header><h1>Your local notepad</h1><p className="overview-muted">Keep the details worth coming back to.</p></header>
        <form id="note-form" action="popup.html" method="post" onSubmit={save} className="popup-note-form"><label htmlFor="note-text">New note <span className="overview-muted">(required)</span></label><p id="note-hint" className="overview-muted">Or select text on a page and choose Save to notes.</p><textarea ref={editor} id="note-text" name="note" required rows={3} placeholder="An address, a thought, a useful detail…" value={draft} aria-invalid={invalid || undefined} aria-describedby={`note-hint${invalid ? ' note-error' : ''}`} onInvalid={() => setInvalid(true)} onChange={e => { setDraft(e.target.value); setInvalid(false); e.target.setCustomValidity(''); }} />{invalid && <p id="note-error" className="popup-field-error">Enter a note before saving.</p>}<button id="save-note" className="popup-button primary" type="submit" disabled={saving}><PlusIcon aria-hidden="true" />{saving ? 'Saving…' : 'Save note'}</button></form>
      </article>
      <section className="saved-section" aria-labelledby="saved-title"><div className="section-heading"><h2 id="saved-title">Saved notes</h2><span className="overview-muted">{loaded ? notes.length : '…'}</span></div>
        {!loaded ? <p className="overview-muted" aria-busy="true">Loading notes…</p> : notes.length === 0 ? <div className="popup-empty"><NotebookPenIcon aria-hidden="true" /><h3>{loadError ? 'Saved notes could not be loaded' : 'No saved notes yet'}</h3><p>{loadError ? 'Reopen the popup to try again.' : 'Your next useful find belongs here.'}</p></div> : null}
        <ul ref={list} id="notes-list" aria-label="Saved notes" hidden={!notes.length}>{notes.map(note => <li key={note.id}><p className="note-content">{note.text}</p><div className="note-meta"><span>{note.type === 'selection' ? 'From a page' : note.type === 'url' ? 'Saved link' : 'Personal note'}</span><button type="button" className="popup-link" data-note-id={note.id} aria-disabled={deleting.has(note.id)} aria-label={`Delete note: ${note.text.replace(/\s+/g, ' ').slice(0,60)}`} onClick={() => void remove(note.id)}><Trash2Icon aria-hidden="true" />Delete</button></div></li>)}</ul>
      </section>
    </section>
    <p id="status" role="status" aria-atomic="true" className="status">{status}</p>
    <PopupSocial />
    <footer className="popup-footer"><nav aria-label="More tools"><button className="popup-link" onClick={() => setTab(tab === 'notes' ? 'property' : 'notes')}><NotebookPenIcon aria-hidden="true" />{tab === 'notes' ? 'Property' : 'Notes'}{loaded && notes.length > 0 && <span className="popup-badge">{notes.length}</span>}</button><button id="show-widget" className="popup-link" onClick={() => void action(async () => { const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!Number.isInteger(activeTab?.id)) throw new Error(); const result = await chrome.tabs.sendMessage(activeTab.id!, { type: 'SHOW_WIDGET' }, { frameId: 0 }); if (!result?.ok) throw new Error(); }, 'Page widget shown.', 'Could not show the widget. Open a regular web page and reload it, then try again.')}><MousePointer2Icon aria-hidden="true" />Page widget</button></nav><p className="privacy"><LockKeyholeIcon aria-hidden="true" />Notes stay in this browser.</p></footer>
  </main>;
}
