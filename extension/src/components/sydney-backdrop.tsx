/**
 * Decorative blue-hour Sydney street scene behind the chat: three skyline layers panning at
 * different speeds, headlight and tail-light trails, and a light-rail tram. Drawn in SVG so it
 * ships no image or video. Purely decorative; motion stops under prefers-reduced-motion.
 */

const TILE = 1600;      // each layer repeats every TILE units so the pan loops without a seam
const HORIZON = 700;

/** A skyline silhouette from [width, height] pairs, closed along the horizon. */
function skyline(blocks: [number, number][]) {
  let x = 0;
  let path = `M0 ${HORIZON}`;
  for (const [width, height] of blocks) {
    path += ` V${HORIZON - height} H${x + width}`;
    x += width;
  }
  return `${path} V${HORIZON} Z`;
}

const FAR: [number, number][] = [[70, 120], [50, 190], [90, 150], [40, 230], [80, 170], [60, 110], [100, 200], [50, 260], [70, 180], [90, 130],
  [60, 220], [80, 160], [40, 280], [100, 190], [70, 140], [60, 240], [90, 170], [50, 210], [80, 130], [70, 250], [60, 160], [100, 120]];
const MID: [number, number][] = [[560, 0], [90, 210], [60, 300], [110, 240], [50, 0], [70, 330], [90, 260], [40, 0], [120, 220], [60, 350],
  [80, 270], [70, 190], [100, 310], [90, 230]];
const NEAR: [number, number][] = [[130, 70], [90, 120], [150, 90], [70, 60], [120, 140], [100, 100], [160, 70], [80, 130], [140, 95],
  [110, 115], [90, 65], [130, 135], [100, 85], [130, 105]];

/** Lit windows as a sparse grid of small panes, placed deterministically (no randomness between renders). */
function windows(blocks: [number, number][], every: number) {
  const lights: { x: number; y: number }[] = [];
  let x = 0;
  blocks.forEach(([width, height], index) => {
    const columns = Math.floor((width - 14) / 13);
    const rows = Math.floor((height - 14) / 17);
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      if ((index * 31 + row * 17 + column * 7 + row * column) % every === 0) lights.push({ x: x + 10 + column * 13, y: HORIZON - height + 12 + row * 17 });
    }
    x += width;
  });
  return lights;
}

function Tiles({ children }: { children: React.ReactNode }) {
  return <>{children}<g transform={`translate(${TILE} 0)`}>{children}</g></>;
}

const TRAILS = [
  { y: 792, length: 260, colour: 'url(#sydney-head)', speed: 5.5, delay: 0, back: false },
  { y: 806, length: 180, colour: 'url(#sydney-head)', speed: 7, delay: -3.1, back: false },
  { y: 798, length: 320, colour: 'url(#sydney-head)', speed: 6.2, delay: -4.4, back: false },
  { y: 846, length: 240, colour: 'url(#sydney-tail)', speed: 6.4, delay: -1.2, back: true },
  { y: 860, length: 300, colour: 'url(#sydney-tail)', speed: 5.2, delay: -3.8, back: true },
  { y: 852, length: 170, colour: 'url(#sydney-tail)', speed: 7.6, delay: -5.5, back: true },
];

export function SydneyBackdrop() {
  return <div className="sydney-backdrop" aria-hidden="true">
    <svg viewBox={`0 0 ${TILE} 900`} preserveAspectRatio="xMidYMax slice" focusable="false">
      <defs>
        <linearGradient id="sydney-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#051233" /><stop offset=".42" stopColor="#0b3a8c" /><stop offset=".7" stopColor="#3f7fd9" /><stop offset=".78" stopColor="#f0b48a" />
        </linearGradient>
        <radialGradient id="sydney-glow" cx=".62" cy=".78" r=".45"><stop offset="0" stopColor="#ffd9b0" stopOpacity=".55" /><stop offset="1" stopColor="#ffd9b0" stopOpacity="0" /></radialGradient>
        <linearGradient id="sydney-head" x1="0" x2="1"><stop offset="0" stopColor="#fff4d6" stopOpacity="0" /><stop offset="1" stopColor="#fff4d6" /></linearGradient>
        <linearGradient id="sydney-tail" x1="0" x2="1"><stop offset="0" stopColor="#ff5a4d" /><stop offset="1" stopColor="#ff5a4d" stopOpacity="0" /></linearGradient>
        <linearGradient id="sydney-road" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0b1d44" /><stop offset="1" stopColor="#050d22" /></linearGradient>
      </defs>
      <rect width={TILE} height="900" fill="url(#sydney-sky)" />
      <rect width={TILE} height="900" fill="url(#sydney-glow)" />

      <g className="sydney-pan" style={{ '--pan': '260s' } as React.CSSProperties}><Tiles>
        <path d={skyline(FAR)} fill="#2a63bd" opacity=".55" />
      </Tiles></g>

      <g className="sydney-pan" style={{ '--pan': '170s' } as React.CSSProperties}><Tiles>
        {/* Harbour Bridge: arch, deck, hangers and pylons */}
        <g fill="none" stroke="#123a7d" strokeLinecap="round">
          <path d="M70 640 Q290 380 510 640" strokeWidth="10" />
          <path d="M70 640 Q290 470 510 640" strokeWidth="5" />
          <path d="M30 640 H550" strokeWidth="9" />
          {[130, 180, 230, 290, 350, 400, 450].map(x => <path key={x} d={`M${x} 640 V${640 - (1 - ((x - 290) / 220) ** 2) * 128}`} strokeWidth="2" />)}
        </g>
        <path d="M40 700 V600 H78 V700 Z M502 700 V600 H540 V700 Z" fill="#123a7d" />
        {/* Opera House sails */}
        <path d="M585 700 Q600 610 660 590 Q640 650 640 700 Z M640 700 Q660 600 730 570 Q705 640 700 700 Z M700 700 Q725 620 790 600 Q770 655 765 700 Z" fill="#dfe9fb" opacity=".9" />
        <path d={skyline(MID)} fill="#123a7d" />
        {/* Sydney Tower: shaft, turret and spire */}
        <path d="M1068 700 V330 H1076 V700 Z M1046 330 H1098 L1090 300 H1054 Z M1054 300 H1090 V286 H1054 Z M1070 286 V230 H1074 V286 Z" fill="#123a7d" />
        <rect x="1052" y="306" width="40" height="5" fill="#ffd08a" />
        {windows(MID, 5).map((light, index) => <rect key={index} x={light.x} y={light.y} width="5" height="7" fill="#ffe2ad" opacity=".55" />)}
      </Tiles></g>

      <g className="sydney-pan" style={{ '--pan': '95s' } as React.CSSProperties}><Tiles>
        <path d={skyline(NEAR)} fill="#0a2152" />
        {windows(NEAR, 4).map((light, index) => <rect key={index} x={light.x} y={light.y} width="5" height="7" fill="#ffe7bd" opacity=".75" />)}
      </Tiles></g>

      <rect y={HORIZON} width={TILE} height={900 - HORIZON} fill="url(#sydney-road)" />
      <rect y={HORIZON} width={TILE} height="3" fill="#7fb0ff" opacity=".35" />
      <g className="sydney-pan" style={{ '--pan': '9s' } as React.CSSProperties}><Tiles>
        {Array.from({ length: 16 }, (_, index) => <rect key={index} x={index * 100 + 20} y="822" width="52" height="4" rx="2" fill="#c9dcff" opacity=".35" />)}
      </Tiles></g>

      {/* Light rail on the kerb-side track */}
      <g className="sydney-tram">
        <rect x="0" y="728" width="330" height="40" rx="14" fill="#c8102e" />
        <rect x="0" y="752" width="330" height="16" rx="8" fill="#f4f6fb" />
        {Array.from({ length: 7 }, (_, index) => <rect key={index} x={18 + index * 44} y="735" width="32" height="14" rx="3" fill="#ffe9c2" />)}
      </g>

      {TRAILS.map((trail, index) => <rect key={index} className={trail.back ? 'sydney-trail back' : 'sydney-trail'} y={trail.y} width={trail.length} height="5" rx="2.5" fill={trail.colour}
        style={{ '--speed': `${trail.speed}s`, '--delay': `${trail.delay}s` } as React.CSSProperties} />)}
    </svg>
  </div>;
}
