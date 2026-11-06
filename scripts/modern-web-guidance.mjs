#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.0.197";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(ROOT, ".tools");
const PACKAGE = join(TOOLS, "modern-web-guidance");
const RECORD = join(TOOLS, "modern-web-guidance-install.json");
const CLI_DIR = join("skills", "modern-web-guidance");
const CLI = join(CLI_DIR, "modern-web.mjs");
const USAGE = `Usage: node scripts/modern-web-guidance.mjs <command> [arguments]

  setup [--from <package-directory>]  Copy the pinned CLI from a local npm install
  search "<query>"                    Search the bundled guides offline
  retrieve <ids>                      Retrieve guides by ID (comma-separated)
  list                                List the bundled guides

Requires Node.js 22 or newer. Pinned CLI version: ${VERSION}.
Only setup writes tooling files; queries never install or update packages.`;

function recovery() {
  return `Run setup from this project:
  node scripts/modern-web-guidance.mjs setup

If the pinned package is not cached, run these commands from this project in a
network-enabled terminal (the install stays in ignored project-local storage):
  npm install --prefix .tools/modern-web-guidance-download --cache .tools/npm-cache --no-audit --no-fund --ignore-scripts --save-exact modern-web-guidance@${VERSION}
  node scripts/modern-web-guidance.mjs setup --from .tools/modern-web-guidance-download/node_modules/modern-web-guidance`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validatePackage(directory) {
  const metadata = readJson(join(directory, "package.json"));
  if (metadata.name !== "modern-web-guidance" || metadata.version !== VERSION ||
      metadata.publisher !== "GoogleChrome" || metadata.bin?.["modern-web-guidance"] !== CLI.replaceAll("\\", "/")) {
    throw new Error(`Expected the GoogleChrome modern-web-guidance@${VERSION} package at ${directory}.`);
  }
  const data = join(directory, CLI_DIR);
  const guides = readJson(join(data, "guides.json"));
  if (!Array.isArray(guides) || guides.length === 0) {
    throw new Error(`Missing guide index at ${data}.`);
  }
  const required = [
    "package.json", "LICENSE", "THIRD_PARTY_NOTICES", CLI,
    ...[
      "search.mjs", "skill-version.txt", "use-cases.vectors.gen.json.gz",
      "tfjs-model-minilm/model.json", "tfjs-model-minilm/group1-shard1of1.bin",
      "tfjs-model-minilm/tokenizer.json.gz", "tfjs-model-minilm/tokenizer_config.json",
      "watchdog/main.js",
    ].map((file) => join(CLI_DIR, file)),
  ];
  for (const guide of guides) {
    if (!/^[a-z0-9-]+$/.test(guide.id) || !/^[a-z0-9-]+$/.test(guide.category)) {
      throw new Error(`Invalid guide index at ${data}.`);
    }
    required.push(join(CLI_DIR, "guides", guide.category, `${guide.id}.md`));
  }
  for (const file of required) {
    const path = join(directory, file);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
      throw new Error(`Incomplete CLI package: missing or empty ${file}.`);
    }
  }
  return metadata;
}

function cachedPackages() {
  // Include the normal cache even if the caller selected an empty temporary one.
  const caches = new Set([
    process.env.npm_config_cache,
    process.env.NPM_CONFIG_CACHE,
    join(homedir(), ".npm"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "npm-cache"),
  ].filter(Boolean));
  const candidates = [];
  for (const cache of caches) {
    const npx = join(resolve(cache), "_npx");
    if (!existsSync(npx)) continue;
    for (const entry of readdirSync(npx, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        const candidate = join(npx, entry.name, "node_modules", "modern-web-guidance");
        if (existsSync(candidate)) candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function setup(args) {
  if (args.length && (args.length !== 2 || args[0] !== "--from" || !args[1])) {
    throw new Error("Usage: node scripts/modern-web-guidance.mjs setup [--from <package-directory>]");
  }
  if (!args.length && existsSync(PACKAGE) && existsSync(RECORD)) {
    try {
      validatePackage(PACKAGE);
      const record = readJson(RECORD);
      if (record.version === VERSION && record.source) {
        console.log(`modern-web-guidance@${VERSION} is already ready in .tools/modern-web-guidance.`);
        return;
      }
    } catch {
      // An incomplete local copy can be repaired from a complete cached package.
    }
  }

  const candidates = args.length ? [resolve(args[1])] : cachedPackages();
  const failures = [];
  let source;
  for (const candidate of candidates) {
    try {
      validatePackage(candidate);
      source = candidate;
      break;
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  if (!source) {
    throw new Error(`No complete modern-web-guidance@${VERSION} package was found locally.${failures.length ? `\n${failures.join("\n")}` : ""}\n\n${recovery()}`);
  }

  mkdirSync(TOOLS, { recursive: true });
  const staging = mkdtempSync(join(TOOLS, ".modern-web-guidance-"));
  try {
    const stagedPackage = join(staging, "package");
    cpSync(source, stagedPackage, { recursive: true, dereference: true });
    validatePackage(stagedPackage);
    // Copy and validate first, so a bad source never removes a working install.
    rmSync(PACKAGE, { recursive: true, force: true });
    renameSync(stagedPackage, PACKAGE);
    writeFileSync(RECORD, `${JSON.stringify({
      name: "modern-web-guidance",
      version: VERSION,
      source,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    console.log(`Ready: modern-web-guidance@${VERSION} in .tools/modern-web-guidance (copied from ${source}).`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error(`Node.js 22 or newer is required; found ${process.versions.node}.`);
  }
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command === "setup") return setup(args);
  if (!["search", "retrieve", "list"].includes(command)) {
    throw new Error(USAGE);
  }
  if (command === "list" ? args.length !== 0 : args.length === 0 || args.some((arg) => arg.startsWith("-"))) {
    throw new Error(`Invalid arguments for ${command}.\n\n${USAGE}`);
  }
  try {
    validatePackage(PACKAGE);
  } catch (error) {
    throw new Error(`Local guidance CLI is missing or incomplete: ${error.message}\n\n${recovery()}`);
  }

  const forwarded = [command, ...args];
  if (command === "search") {
    const skill = readFileSync(join(ROOT, ".agents", "skills", "modern-web-guidance", "SKILL.md"), "utf8");
    const version = skill.match(/--skill-version\s+(\d{4}_\d{2}_\d{2}-[a-z0-9]+)/)?.[1];
    if (!version) throw new Error("Cannot find --skill-version in the installed project's modern-web-guidance SKILL.md.");
    forwarded.push("--skill-version", version);
  }
  const result = spawnSync(process.execPath, [join(PACKAGE, CLI), ...forwarded], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DISABLE_TELEMETRY: "1", ENABLE_FILE_LOGGING: "false" },
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status ?? 1;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
