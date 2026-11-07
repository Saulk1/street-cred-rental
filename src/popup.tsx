import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Settings2Icon, PanelRightIcon, MousePointer2Icon, PlusIcon, Trash2Icon, NotebookPenIcon, LockKeyholeIcon, HouseIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { Brand } from '@/components/brand';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
    <div className="popup-header"><Brand compact /><nav className="popup-tools" aria-label="Extension tools">
      <Button id="open-side-panel" variant="outline" size="icon" aria-label="Side panel" disabled={windowId === undefined} onClick={() => void action(() => chrome.sidePanel.open({ windowId: windowId! }), 'Side panel opened.', 'Could not open the side panel. Try again in Chrome 116 or newer.')}><PanelRightIcon aria-hidden="true" /></Button>
      <Button id="open-options" variant="ghost" size="icon" aria-label="Open options" onClick={() => void action(() => chrome.runtime.openOptionsPage(), 'Options opened.', 'Could not open options. Please try again.')}><Settings2Icon aria-hidden="true" /></Button>
    </nav></div><p className="popup-tagline">A little local knowledge.</p>
    <Tabs value={tab} onValueChange={setTab} className="gap-4">
    <TabsList variant="line" className="w-full" aria-label="Popup tools"><TabsTrigger value="property"><HouseIcon aria-hidden="true" />Property</TabsTrigger><TabsTrigger value="notes"><NotebookPenIcon aria-hidden="true" />Notes{loaded && notes.length > 0 && <Badge variant="secondary">{notes.length}</Badge>}</TabsTrigger></TabsList>
    <TabsContent value="property" forceMount hidden={tab !== 'property'}><PropertyReport onSave={saveProperty} /></TabsContent>
    <TabsContent value="notes" forceMount hidden={tab !== 'notes'} className="flex flex-col gap-4">
    <Card><CardHeader><CardTitle><h1>Your local notepad</h1></CardTitle><CardDescription>Keep the details worth coming back to.</CardDescription></CardHeader><CardContent>
      <form id="note-form" action="popup.html" method="post" onSubmit={save}><FieldGroup><Field data-invalid={invalid || undefined}><FieldLabel htmlFor="note-text">New note <span className="text-muted-foreground">(required)</span></FieldLabel><FieldDescription id="note-hint">Or select text on a page and choose Save to notes.</FieldDescription><Textarea ref={editor} id="note-text" name="note" required rows={3} placeholder="An address, a thought, a useful detail…" value={draft} aria-invalid={invalid || undefined} aria-describedby={`note-hint${invalid ? ' note-error' : ''}`} onInvalid={() => setInvalid(true)} onChange={e => { setDraft(e.target.value); setInvalid(false); e.target.setCustomValidity(''); }} />{invalid && <FieldDescription id="note-error">Enter a note before saving.</FieldDescription>}</Field><Button id="save-note" type="submit" disabled={saving}>{saving ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" aria-hidden="true" />}Save note</Button></FieldGroup></form>
    </CardContent></Card>
    <section className="saved-section" aria-labelledby="saved-title"><div className="section-heading"><h2 id="saved-title">Saved notes</h2><span className="text-muted-foreground">{loaded ? notes.length : '…'}</span></div>
      {!loaded ? <div aria-label="Loading notes" aria-busy="true" className="flex flex-col gap-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div> : notes.length === 0 ? <Empty><EmptyHeader><EmptyMedia variant="icon"><NotebookPenIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>{loadError ? "Saved notes could not be loaded" : "No saved notes yet"}</EmptyTitle><EmptyDescription>{loadError ? "Reopen the popup to try again." : "Your next useful find belongs here."}</EmptyDescription></EmptyHeader></Empty> : null}
      <ul ref={list} id="notes-list" aria-label="Saved notes" hidden={!notes.length}>{notes.map(note => <li key={note.id}><p className="note-content">{note.text}</p><div className="note-meta"><span>{note.type === 'selection' ? 'From a page' : note.type === 'url' ? 'Saved link' : 'Personal note'}</span><Button type="button" variant="ghost" size="sm" data-note-id={note.id} aria-disabled={deleting.has(note.id)} aria-label={`Delete note: ${note.text.replace(/\s+/g, ' ').slice(0,60)}`} onClick={() => void remove(note.id)}><Trash2Icon data-icon="inline-start" aria-hidden="true" />Delete</Button></div></li>)}</ul>
    </section>
    </TabsContent></Tabs>
    <p id="status" role="status" aria-atomic="true" className="status">{status}</p>
    <footer className="popup-footer"><Button id="show-widget" variant="link" size="sm" onClick={() => void action(async () => { const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!Number.isInteger(activeTab?.id)) throw new Error(); const result = await chrome.tabs.sendMessage(activeTab.id!, { type: 'SHOW_WIDGET' }, { frameId: 0 }); if (!result?.ok) throw new Error(); }, 'Page widget shown.', 'Could not show the widget. Open a regular web page and reload it, then try again.')}><MousePointer2Icon data-icon="inline-start" aria-hidden="true" />Page widget</Button><p className="privacy"><LockKeyholeIcon className="size-3" aria-hidden="true" />Notes stay in this browser.</p></footer>
  </main>;
}
