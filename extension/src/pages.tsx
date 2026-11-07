import { createRoot } from 'react-dom/client';
import { MapPinIcon, MousePointer2Icon, NotebookPenIcon, LockKeyholeIcon, ArrowUpRightIcon } from 'lucide-react';
import { Popup } from '@/popup';
import { PropertyChat } from '@/chat';
import { Brand } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import './styles.css';

function Guide({ page }: { page: string }) {
  const welcome = page === 'welcome', panel = page === 'sidepanel';
  return <main className="guide-shell"><Brand /><section className="guide-intro"><p className="eyebrow">{welcome ? 'WELCOME TO THE NEIGHBOURHOOD' : panel ? 'YOUR PROPERTY COMPANION' : 'ABOUT & HOW TO USE'}</p><h1>{welcome ? 'A closer look at local.' : panel ? 'Good questions start here.' : 'Make yourself at home.'}</h1><p>Select an address. Get the local picture.<br />Keep the details that matter to you.</p></section><div className="guide-grid">
    <Card><CardHeader><CardTitle><h2>From address to insight</h2></CardTitle><CardDescription>Property research, right where you browse.</CardDescription></CardHeader><CardContent><ol className="steps"><li><span className="step-icon"><MousePointer2Icon aria-hidden="true" /></span><div><h3>Select an address</h3><p>Highlight a full property address on a webpage, including the unit and suburb.</p></div></li><li><span className="step-icon"><MapPinIcon aria-hidden="true" /></span><div><h3>Look up property</h3><p>Choose Look up property in the selection card or right-click menu. Confirm the matching address to see facts, an automated valuation and overlays.</p></div></li><li><span className="step-icon"><NotebookPenIcon aria-hidden="true" /></span><div><h3>Keep a useful detail</h3><p>Select any page text and choose Save to notes. Open the toolbar popup to write, view or delete notes.</p></div></li></ol></CardContent><CardFooter><Badge variant="secondary">City of Sydney LGA</Badge></CardFooter></Card>
    <Card><CardHeader><CardTitle><h2>Your notes, close by</h2></CardTitle><CardDescription>A small space for useful finds.</CardDescription></CardHeader><CardContent><p>Pin Microburbs Facts using Chrome’s Extensions menu, then click its icon to open your notepad.</p><p className="guide-paragraph">Notes are saved in this Chrome profile. They stay through extension reloads and browser restarts; uninstalling removes them. Save a draft before closing the popup.</p><div className="privacy-note"><LockKeyholeIcon className="size-4" aria-hidden="true" /><p>Notes are local. Property lookup sends only the address you choose to the Microburbs API.</p></div></CardContent></Card>
  </div><Alert role="note"><MapPinIcon aria-hidden="true" /><AlertTitle>Useful context for your next question</AlertTitle><AlertDescription>Valuations are model estimates. Overlays and nearby features provide context and do not replace a formal appraisal or planning certificate.</AlertDescription></Alert>{!panel && <Button asChild variant="outline"><a href="https://www.microburbs.com.au" target="_blank" rel="noreferrer">Explore Microburbs<ArrowUpRightIcon data-icon="inline-end" aria-hidden="true" /></a></Button>}<footer className="guide-footer">Microburbs Facts · Built by Street Cred <span>Hackathon 2026 · Beta</span></footer></main>;
}
const page = document.body.dataset.page ?? 'popup';
createRoot(document.getElementById('root')!).render(page === 'popup' ? <Popup /> : page === 'options' ? <PropertyChat /> : <Guide page={page} />);
