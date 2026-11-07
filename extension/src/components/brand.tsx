import { Badge } from '@/components/ui/badge';
export function Brand({ compact = false }: { compact?: boolean }) {
  return <header className="brand"><img src={chrome.runtime.getURL('icons/icon-128.png')} width={compact ? 28 : 36} height={compact ? 28 : 36} alt="" /><div><p className="brand-name">Microburbs <span>Facts</span></p>{!compact && <p className="eyebrow">A little local knowledge.</p>}</div><Badge variant="secondary">Beta</Badge></header>;
}
