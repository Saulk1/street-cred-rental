import { count, eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { getDatabase } from '../../server/db';
import { energyReports } from '../../server/db/schema';

// Explicitly opt in after migrating and importing example.csv on the test branch.
it.skipIf(!process.env.TEST_DATABASE_URL || process.env.TEST_ENERGY_REPORTS !== '1')(
  'reads the imported records through Drizzle with exact decimals, zeros and nulls', async () => {
    vi.stubEnv('DATABASE_URL', process.env.TEST_DATABASE_URL!);
    const db = getDatabase(AbortSignal.timeout(10_000));
    const [total] = await db.select({ rows: count() }).from(energyReports);
    expect(total.rows).toBe(9143);

    const [decimal] = await db.select().from(energyReports).where(eq(energyReports.id, 357186));
    expect(decimal).toMatchObject({
      year: 1990, fy: '1989-90', code: 'ACT', reportCategory: 'SECTOR',
      name: 'LULUCF', co2: '-170365.23783841022', reportDate: null, gj: null,
    });
    const [zero] = await db.select().from(energyReports).where(eq(energyReports.id, 89917));
    expect(zero).toMatchObject({ co2: '0', co2Scope1: '0', co2Scope2: '0', mwh: '5373', gj: '19343' });
    const [missing] = await db.select().from(energyReports).where(eq(energyReports.id, 54442));
    expect(missing).toMatchObject({ reportDate: null, co2: null, gj: '503000000' });
  }, 15_000,
);
