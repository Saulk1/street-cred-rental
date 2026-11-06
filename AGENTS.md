# Project instructions

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

The extension is plain HTML, CSS and JavaScript. Development tooling belongs outside
runtime files. Package it with `python3 scripts/package.py`; its allowlist must keep
`.tools/`, agent instructions and all other development files out of the ZIP.

## Git commits and pushes

Use Git CLI to commit and push this project to
`https://github.com/sibo-zhang25/microburbs-facts.git`. Preserve the remote history
and review staged files before committing. Do not force-push.

If terminal network access or authentication fails, report the exact blocker and
the terminal step needed to resolve it. Do not fall back to browser file uploads
or GitHub Contents API uploads.
