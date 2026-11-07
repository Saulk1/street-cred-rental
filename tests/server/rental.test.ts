import { beforeEach, expect, it, vi } from 'vitest';
import { rentalCommand, rental, type SessionStore } from '../../server/rental';
import { validRentalCommand, validRentalReply, type RentalReply } from '../../shared/rental';
const result = { action: 'no_match', reason_code: 'no_feasible_listing', provenance: {
  snapshotDate: '2026-11-07T01:10:58Z', artifactVersion: 'a'.repeat(64), modelVersion: 'test-model', advisorVersion: '1.0.0' }, warnings: ['Dated snapshot.'] };
const context={token:'b'.repeat(64),revision:0};
const signal=new AbortController().signal;
function memory() {
  let session:any; const events=new Map<string,any>();
  const store:SessionStore={
    async read(){return session;}, async create(){session??={revision:0,state:null,artifact_version:null};},
    async event(_key,id){return events.get(id);},
    async commit(_key,revision,id,requestHash,state,artifact,reply){if(session.revision!==revision)return false;
      session={revision:reply.revision,state,artifact_version:artifact,result:reply.result};events.set(id,{request_hash:requestHash,reply});return true;},
    async end(_key,revision){if(!session||revision!==session.revision)return false;session=undefined;events.clear();return true;}
  }; return {store,events};
}
beforeEach(()=>{
 vi.stubEnv('COMPUTE_API_URL','https://compute.test/api/compute');vi.stubEnv('COMPUTE_SERVICE_TOKEN','dummy-compute-token-32-characters-long');
 vi.stubEnv('CHAT_ACCESS_TOKEN','team');
 vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({status:'ok',calculator:'rental_advisor',version:'1.0.0',artifactVersion:'a'.repeat(64),state:{schema:1},result}));
 vi.spyOn(console,'info').mockImplementation(()=>{});
});
it('persists once, recovers retries and rejects reused event IDs with different content',async()=>{
 const {store}=memory();const command={operation:'start' as const,text:'budget 800'};
 const a=await rentalCommand(context,'event1',command,signal,undefined,store);
 expect(a).toMatchObject({revision:1,result});
 expect(await rentalCommand({...context,revision:1},'event1',{...command,operation:'message'},signal,undefined,store)).toEqual(a);
 expect(fetch).toHaveBeenCalledTimes(1);
 await expect(rentalCommand(context,'event1',{...command,text:'budget 900'},signal,undefined,store)).rejects.toMatchObject({code:'conflict'});
});
it('uses CAS for simultaneous answers and allows resume with an older revision',async()=>{
 const {store}=memory(); await rentalCommand(context,'start',{operation:'start',text:'rent'},signal,undefined,store);
 const active={...context,revision:1};
 const replies=await Promise.allSettled(['a','b'].map(event=>rentalCommand(active,event,{operation:'message',text:event},signal,undefined,store)));
 expect(replies.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(replies.filter(r=>r.status==='rejected')).toHaveLength(1);
 const resumed=await rentalCommand(context,'resume',{operation:'resume'},signal,undefined,store) as RentalReply;
 expect(resumed.revision).toBe(3);
 await expect(rentalCommand(context,'old',{operation:'message',text:'rent'},signal,undefined,store)).rejects.toMatchObject({code:'conflict'});
});
it('ends sessions, treats missing sessions as expired, and never returns capabilities',async()=>{
 const {store}=memory(); const reply=await rentalCommand(context,'start',{operation:'start',text:'rent'},signal,undefined,store);
 expect(JSON.stringify(reply)).not.toContain(context.token);
 await rentalCommand({...context,revision:1},'end',{operation:'end'},signal,undefined,store);
 await expect(rentalCommand(context,'resume',{operation:'resume'},signal,undefined,store)).rejects.toMatchObject({code:'expired'});
});
it('validates answers, result boundaries and endpoint authentication',async()=>{
 expect(validRentalCommand({operation:'answer',questionId:'q',text:'custom',optionId:'yes'})).toBe(false);
 expect(validRentalCommand({operation:'answer',questionId:'q',optionId:'skip'})).toBe(true);
 expect(validRentalReply({revision:1,result})).toBe(true);
 expect(validRentalReply({revision:1,result:{...result,recommendations:[{listing_id:'fake'}]}})).toBe(false);
 expect((await rental(new Request('https://test/api/rental'))).status).toBe(405);
 expect((await rental(new Request('https://test/api/rental',{method:'POST'}))).status).toBe(401);
 const request=new Request('https://test/api/rental',{method:'POST',headers:{Authorization:'Bearer team','Content-Type':'application/json'},body:JSON.stringify({context,command:{operation:'start',text:'rent',state:{}},eventId:'x'})});
 expect((await rental(request)).status).toBe(400);
});
