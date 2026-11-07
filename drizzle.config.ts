import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './drizzle',
  // Never fall back to the read-only application's connection string.
  dbCredentials: process.env.DATABASE_MIGRATION_URL
    ? { url: process.env.DATABASE_MIGRATION_URL }
    : undefined,
});
