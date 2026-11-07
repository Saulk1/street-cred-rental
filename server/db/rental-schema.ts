import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// Anonymous rental capabilities are hashed before storage. All writes use revision checks.
export const rentalSessions = pgTable('rental_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  revision: integer('revision').notNull().default(0),
  artifactVersion: text('artifact_version'),
  state: jsonb('state').$type<Record<string, unknown>>(),
  result: jsonb('result'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, table => [index('rental_sessions_expiry_idx').on(table.expiresAt)]);
export const rentalEvents = pgTable('rental_events', {
  sessionHash: text('session_hash').notNull().references(() => rentalSessions.tokenHash, { onDelete: 'cascade' }),
  eventId: text('event_id').notNull(),
  requestHash: text('request_hash').notNull(),
  reply: jsonb('reply').notNull(),
}, table => [primaryKey({ columns: [table.sessionHash, table.eventId] })]);
