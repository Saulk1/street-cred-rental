import { build } from 'vite';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Separate IIFEs avoid module imports in MV3 classic content scripts and make
// the runtime resource allowlist deterministic. Dependencies are bundled locally.
for (const entry of ['pages', 'injected']) {
  await build({
    root,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: '.build/' + entry,
      emptyOutDir: true,
      sourcemap: false,
      lib: { entry: resolve(root, `src/${entry}.tsx`), name: entry === 'injected' ? 'MicroburbsUI' : 'MicroburbsPages', formats: ['iife'], fileName: () => `${entry}.js`, cssFileName: entry },

    },
  });
}
const output = resolve(root, '.build/runtime/ui');
await mkdir(output, { recursive: true });
for (const name of ['pages.js', 'pages.css']) await copyFile(resolve(root, '.build/pages', name), resolve(output, name));
await copyFile(resolve(root, '.build/injected/injected.js'), resolve(output, 'injected.js'));
let theme = await readFile(resolve(root, '.build/injected/injected.css'), 'utf8');
// @property registrations inside shadow stylesheets are not interoperable.
// Initialize Tailwind's typed custom properties within each isolated tree.
const defaults = [];
theme = theme.replace(/@property\s+(--[\w-]+)\s*\{([^}]+)\}/g, (_, name, body) => {
  const initial = body.match(/initial-value\s*:\s*([^;}]+)/);
  if (initial) defaults.push(`${name}:${initial[1]}`);
  return '';
});
theme += `\n@layer base{:host,:host *, :host *::before, :host *::after{${defaults.join(';')}}}`;
// Host pages choose their own root font size. Pin the injected UI's rem scale
// while retaining browser zoom and avoiding page CSS changing control geometry.
theme = theme.replace(/(-?[\d.]+)rem\b/g, (_, value) => `${Number(value) * 16}px`);
for (const [source, target] of [['selection-card.css', 'selection-card.css'], ['content-script.css', 'widget.css']]) {
  const host = await readFile(resolve(root, 'content-script', source), 'utf8');
  await writeFile(resolve(output, target), theme + '\n' + host);
}
