# Project instructions

## Mandatory UI standard: shadcn

**All UI component work must use the installed
`.agents/skills/shadcn/SKILL.md` skill.** Read and follow it when creating,
editing, styling or composing any UI component across every extension surface.

- Use official shadcn components and compose them for app-specific interfaces.
- Follow the skill's component discovery, documentation, composition and semantic
  styling rules.
- **Do not introduce or use other UI frameworks or component libraries.** The
  existing React, Tailwind CSS and shadcn Radix primitives remain the approved
  implementation stack.
- Modern Web Guidance remains required alongside the shadcn skill for HTML, CSS
  and client-side JavaScript work.

## Modern Web Guidance

Use the installed `.agents/skills/modern-web-guidance/SKILL.md` for HTML, CSS and
client-side JavaScript work. In this project, run its queries through the local
launcher instead of `npx ...@latest`:

```sh
node scripts/modern-web-guidance.mjs setup
node scripts/modern-web-guidance.mjs search "<focused action-oriented query>"
node scripts/modern-web-guidance.mjs retrieve <guide-id>
node scripts/modern-web-guidance.mjs list
```

Setup copies the complete pinned CLI version 0.0.197 from a local npm cache into
ignored `.tools/` storage. Run it once, or again to repair missing tooling. Normal
queries never install, update or download packages. Do not use `--offline` with an
empty temporary npm cache. If setup reports no cached package, follow its exact
network-enabled terminal instructions; do not change global npm settings.

The launcher reads the installed skill's version for searches, disables telemetry
and file logging, and resolves project paths independently of the current working
directory. When outside this project, use an absolute path to the launcher.

Keep the skill's search/retrieve workflow, Origin Trial opt-in rules, full-file
reading instructions and guide attribution requirements. If no CLI can be set up,
report the specific blocker and identify any local guide files used as a fallback.
Do not describe manual file reads as a successful CLI search.

## Extension packaging

The UI uses React, TypeScript, Tailwind v4 and official shadcn Nova/Radix
components. Read `.agents/skills/shadcn/SKILL.md` for shadcn work. Preserve the
vanilla selection lifecycle controller and background/API message contracts.

Install dependencies with `npm ci`. Package with `python3 scripts/package.py`,
which builds the UI first. `npm run build` compiles self-contained page/content
IIFEs to ignored `.build/` storage; the Python runtime allowlist includes only
compiled assets, controllers and required extension resources. Keep `.tools/`,
node_modules, source, agent instructions and all development files out of the ZIP.

Shared UI CSS belongs inside extension pages or shadow roots only. Manifest CSS
must style only the two injected host IDs. Do not inject Tailwind's global reset
into webpages, introduce remote runtime assets, or weaken the CSP.

