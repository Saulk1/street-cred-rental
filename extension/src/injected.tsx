import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { BookmarkPlusIcon, CheckIcon, XIcon, MapPinIcon } from 'lucide-react';
import { FactsBrand } from '@/components/facts-brand';
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
    flushSync(() => root.render(<><header className="selection-brand"><FactsBrand /><p>A little local knowledge.</p></header><button type="button" className="selection-button" ref={node => { if (node) button = node; }} disabled={state.disabled}>{state.saved ? <CheckIcon aria-hidden="true" /> : <BookmarkPlusIcon aria-hidden="true" />}{state.saved ? 'Saved to notes' : 'Save to notes'}</button><p role="status" aria-atomic="true" className="status">{state.message}</p></>));
  }
  update({});
  return { button, update, dispose() { if (disposed) return; disposed = true; root.unmount(); container.remove(); } };
}
export function mountWidget(shadow: ShadowRoot, close: () => void) {
  const container = document.createElement('div'); shadow.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<article className="native-widget"><header><FactsBrand /><button type="button" className="selection-icon-button" aria-label="Close Microburbs Facts widget" onClick={close}><XIcon aria-hidden="true" /></button></header><h2>A little local knowledge.</h2><div className="widget-message"><MapPinIcon aria-hidden="true" /><p>Select a property address on this page, then choose <strong>Look up property</strong>.</p></div><p className="fine-print">You can also select any text and save it to your notes.</p></article>));
  return { dispose() { root.unmount(); container.remove(); } };
}
