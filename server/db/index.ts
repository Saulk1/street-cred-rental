import '../env.mjs';
import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema.js';

// Create per request: the abort signal must never be reused by a warm function.
// Builds and imports do not require database credentials.
export function getDatabase(signal = AbortSignal.timeout(5_000)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not configured.');
  return drizzle({ client: neon(url, { fetchOptions: { signal } }), schema });
}

export async function checkDatabase(): Promise<void> {
  await getDatabase().execute(sql`select 1`);
}
