import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../server/env.mjs';

const child = spawn('python3', ['-m', 'api.compute'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', env: process.env,
});
child.on('error', () => { console.error('Could not start Python 3.12. Install it and retry.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
