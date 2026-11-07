import './server/env.mjs';
import { defineConfig } from 'drizzle-kit';

// An explicit compute migration command targets only the rental session database.
// No main-database or migration-URL fallback is allowed.
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/rental-schema.ts',
  out: './drizzle/compute',
  dbCredentials: process.env.COMPUTE_DATABASE_URL
    ? { url: process.env.COMPUTE_DATABASE_URL }
    : undefined,
});
