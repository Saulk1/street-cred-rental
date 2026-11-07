import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
const keys = ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'TEST_DATABASE_URL', 'TEST_ENERGY_REPORTS'];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function environment(local: string | null, overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'microburbs-env-'));
  roots.push(root);
  mkdirSync(join(root, 'server'));
  mkdirSync(join(root, 'other-working-directory'));
  const loader = join(root, 'server/env.mjs');
  copyFileSync(new URL('../../server/env.mjs', import.meta.url), loader);
  if (local !== null) writeFileSync(join(root, '.env.local'), local);
  writeFileSync(join(root, '.env'), 'DATABASE_URL=wrong-dotenv-file\n');
  writeFileSync(join(root, 'other-working-directory/.env.local'), 'DATABASE_URL=wrong-working-directory\n');
  const env = { ...process.env };
  for (const key of keys) delete env[key];
  Object.assign(env, overrides);
  return spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', `
    await import(${JSON.stringify(pathToFileURL(loader).href)});
    process.stdout.write(JSON.stringify(Object.fromEntries(
      ${JSON.stringify(keys)}.map(key => [key, process.env[key] ?? null])
    )));
  `], { cwd: join(root, 'other-working-directory'), env, encoding: 'utf8' });
}

it('loads the root .env.local without CLI flags or a matching working directory', () => {
  const result = environment([
    'export DATABASE_URL="postgresql://reader:dummy@local.invalid/db"',
    "DATABASE_MIGRATION_URL='postgresql://owner:dummy@local.invalid/db'",
    'TEST_DATABASE_URL=postgresql://test:dummy@test.invalid/db',
    'TEST_ENERGY_REPORTS=1 # explicit integration opt-in',
  ].join('\n'));
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    DATABASE_URL: 'postgresql://reader:dummy@local.invalid/db',
    DATABASE_MIGRATION_URL: 'postgresql://owner:dummy@local.invalid/db',
    TEST_DATABASE_URL: 'postgresql://test:dummy@test.invalid/db',
    TEST_ENERGY_REPORTS: '1',
  });
});

it('preserves exported and deployed overrides while filling missing variables', () => {
  const result = environment('DATABASE_URL=local-value\nDATABASE_MIGRATION_URL=local-owner\n', {
    DATABASE_URL: 'deployment-value', TEST_ENERGY_REPORTS: '0',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    DATABASE_URL: 'deployment-value', DATABASE_MIGRATION_URL: 'local-owner',
    TEST_DATABASE_URL: null, TEST_ENERGY_REPORTS: '0',
  });
});

it('supports deployment without .env.local and never falls back to .env or migration credentials', () => {
  const result = environment(null, { DATABASE_MIGRATION_URL: 'owner-only' });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    DATABASE_URL: null, DATABASE_MIGRATION_URL: 'owner-only',
    TEST_DATABASE_URL: null, TEST_ENERGY_REPORTS: null,
  });
});
