import { sql } from 'drizzle-orm';
import { check, date, index, integer, numeric, pgTable, text } from 'drizzle-orm/pg-core';

// Source: assets/example.csv. Preserve its IDs, fiscal-year labels and measures.
// numeric() intentionally maps to strings so decimal precision is not lost in JS.
export const energyReports = pgTable('energy_reports', {
  id: integer('id').primaryKey(),
  year: integer('year').notNull(),
  fy: text('fy').notNull(),
  reportDate: date('report_date', { mode: 'string' }),
  reportCategory: text('report_category').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  co2: numeric('co2'),
  co2Scope1: numeric('co2_scope1'),
  co2Scope2: numeric('co2_scope2'),
  mwh: numeric('mwh'),
  gj: numeric('gj'),
}, (table) => [
  check('energy_reports_id_positive', sql`${table.id} > 0`),
  check('energy_reports_year_valid', sql`${table.year} between 1 and 9999`),
  check('energy_reports_fy_format', sql`${table.fy} ~ '^[0-9]{4}-[0-9]{2}$'`),
  check('energy_reports_category_not_blank', sql`length(trim(${table.reportCategory})) > 0`),
  check('energy_reports_code_not_blank', sql`length(trim(${table.code})) > 0`),
  check('energy_reports_name_not_blank', sql`length(trim(${table.name})) > 0`),
  index('energy_reports_code_category_year_idx').on(table.code, table.reportCategory, table.year),
]);

export type EnergyReport = typeof energyReports.$inferSelect;
export type NewEnergyReport = typeof energyReports.$inferInsert;
