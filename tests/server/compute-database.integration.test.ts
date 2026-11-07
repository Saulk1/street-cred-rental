import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { getComputeDatabase } from '../../server/db';
import { sessionStore } from '../../server/rental';
import { rentalRecommendation } from '../fixtures/rental';

// Explicit opt-in: writes one randomly named disposable session, then removes it.
it.skipIf(process.env.TEST_COMPUTE_DATABASE !== '1')('reads and writes rental sessions through the dedicated compute database', async () => {
  const key=randomBytes(32).toString('hex');
  const store=sessionStore(AbortSignal.timeout(15000));
  try {
    await store.create(key);
    expect((await store.read(key)).revision).toBe(0);
    const reply={...rentalRecommendation,revision:1};
    expect(await store.commit(key,0,'connection-check','connection-check',{schema:1},'a'.repeat(64),reply)).toBe(true);
    expect((await store.event(key,'connection-check')).reply).toEqual(reply);
    expect((await store.read(key)).revision).toBe(1);
    expect(await store.end(key,1)).toBe(true);
    expect(await store.event(key,'connection-check')).toBeUndefined();
  } finally {
    await getComputeDatabase().execute(sql`delete from rental_sessions where token_hash=${key}`);
  }
},20000);
