import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { BookmarkPlusIcon, CheckIcon, XIcon, MapPinIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardAction } from '@/components/ui/card';
export { attachPropertyLookup } from '@/property-lookup';
import './styles.css';

export function mountSaveAction(shadow: ShadowRoot) {
  const container = document.createElement('div'); container.className = 'save-root'; shadow.append(container);
  const root = createRoot(container);
  let button!: HTMLButtonElement;
  let disposed = false;
  let state = { disabled: false, saved: false, message: '' };
  function update(next: Partial<typeof state>) {
    if (disposed) return;
    state = { ...state, ...next };
    flushSync(() => root.render(<><Button variant="outline" ref={node => { if (node) button = node; }} disabled={state.disabled}>{state.saved ? <CheckIcon data-icon="inline-start" aria-hidden="true" /> : <BookmarkPlusIcon data-icon="inline-start" aria-hidden="true" />}{state.saved ? 'Saved to notes' : 'Save to notes'}</Button><p role="status" aria-atomic="true" className="status">{state.message}</p></>));
  }
  update({});
  return { button, update, dispose() { if (disposed) return; disposed = true; root.unmount(); container.remove(); } };
}
export function mountWidget(shadow: ShadowRoot, close: () => void) {
  const container = document.createElement('div'); shadow.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<Card><CardHeader><CardTitle><h2>Microburbs Facts</h2></CardTitle><CardDescription>A little local knowledge.</CardDescription><CardAction><Button variant="ghost" size="icon" aria-label="Close Microburbs Facts widget" onClick={close}><XIcon aria-hidden="true" /></Button></CardAction></CardHeader><CardContent><div className="widget-message"><MapPinIcon className="size-5" aria-hidden="true" /><p>Select a property address on this page, then choose <strong>Look up property</strong>.</p></div><p className="fine-print">You can also select any text and save it to your notes.</p></CardContent></Card>));
  return { dispose() { root.unmount(); container.remove(); } };
}
