import { execFileSync } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { sessionStore } from '../../server/rental';
import { rentalRecommendation } from '../fixtures/rental';

// Explicit local disposable PG only. No Neon credentials or network requests are used.
const socket = process.env.TEST_RENTAL_LOCAL_PG_PATH;
const enabled = socket?.startsWith('/private/tmp/microburbs-rental-');
const psql = (query: string) => execFileSync('psql', ['-h', socket!, '-p', '55441', '-d', 'postgres', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding:'utf8' }).trim();
it.skipIf(!enabled)('executes the production session SQL with CAS, atomic event rollback, and cascade cleanup in PostgreSQL', async () => {
  vi.stubEnv('COMPUTE_DATABASE_URL','postgresql://test:dummy@ep-dummy.us-east-2.aws.neon.tech/neondb');
  // Translate Neon wire requests to a disposable local PostgreSQL connection.
  vi.spyOn(globalThis,'fetch').mockImplementation(async (_url,init) => {
    const body=JSON.parse(init!.body as string);
    let query=body.query.replace(/\$(\d+)/g, (_:string,n:string) => {
      const value=body.params[Number(n)-1];
      return value===null ? 'null' : "'"+String(value).replaceAll("'","''")+"'";
    });
    query=query.replace('select * from rental_sessions','select row_to_json(rental_sessions)::text from rental_sessions')
      .replace('select request_hash,reply from rental_events',"select json_build_object('request_hash',request_hash,'reply',reply)::text from rental_events")
      .replace('returning event_id',"returning json_build_object('event_id',event_id)::text")
      .replace('returning token_hash',"returning json_build_object('token_hash',token_hash)::text");
    // The internal CAS CTE must still return its raw token_hash for INSERT.
    query=query.replace("returning json_build_object('token_hash',token_hash)::text\n      )",'returning token_hash\n      )');
    const output=psql(query);
    const data=output ? output.split('\n').map(line=>JSON.parse(line)) : [];
    const names=data.length ? Object.keys(data[0]) : [];
    return Response.json({fields:names.map(name=>({name,dataTypeID:['state','result','reply'].includes(name)?3802:name==='revision'?23:25})),
      rows:data.map(row=>names.map(name=>row[name]===null ? null : typeof row[name]==='object'?JSON.stringify(row[name]):String(row[name]))),
      rowCount:data.length,command:query.trim().startsWith('select')?'SELECT':'INSERT',rowAsArray:true});
  });
  const store=sessionStore(new AbortController().signal);
  const key='c'.repeat(64);
  psql(`delete from rental_sessions where token_hash='${key}'`);
  await store.create(key);
  expect((await store.read(key)).revision).toBe(0);
  const reply={...rentalRecommendation,revision:1};
  expect(await store.commit(key,0,'event1','request1',{schema:1},'a'.repeat(64),reply)).toBe(true);
  expect(await store.commit(key,0,'event2','request2',{schema:1},'a'.repeat(64),reply)).toBe(false);
  expect((await store.event(key,'event1')).reply).toEqual(reply);
  // Unique-event failure must roll back the state update in the same statement.
  await expect(store.commit(key,1,'event1','request1',{schema:99},'a'.repeat(64),{...reply,revision:2})).rejects.toThrow();
  expect((await store.read(key)).revision).toBe(1);
  expect(await store.end(key,0)).toBe(false);
  expect(await store.end(key,1)).toBe(true);
  expect(await store.event(key,'event1')).toBeUndefined();
});
