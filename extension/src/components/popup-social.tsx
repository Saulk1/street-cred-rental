import { SocialIcon } from '@/components/social-icon';

// Official accounts linked by https://www2.microburbs.com.au/.
export const socialLinks = [
  { label: 'Instagram', href: 'https://www.instagram.com/microburbs/', brand: 'instagram' },
  { label: 'YouTube', href: 'https://www.youtube.com/channel/UCUollIZedjqNspdu5CjIwBw', brand: 'youtube' },
  { label: 'Facebook', href: 'https://www.facebook.com/microburbs/', brand: 'facebook' },
] as const;

export function PopupSocial() {
  return <aside className="popup-social" aria-label="Follow Microburbs">
    <div><p className="overview-eyebrow">Follow Microburbs</p><p className="social-heading">Suburb insights &amp; market updates</p></div>
    <nav aria-label="Microburbs social media">{socialLinks.map(({ label, href, brand }) =>
      <a key={label} href={href} target="_blank" rel="noopener noreferrer" aria-label={`Microburbs on ${label} (opens in a new tab)`}><SocialIcon brand={brand} /></a>
    )}</nav>
  </aside>;
}
