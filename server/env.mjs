import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

// Resolve from this module so direct imports work outside the repository's cwd.
// Node preserves exported/deployed variables and never expands shell expressions.
try {
  loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)));
} catch (error) {
  // Deployments supply environment variables without uploading the local file.
  if (error.code !== 'ENOENT') throw error;
}
