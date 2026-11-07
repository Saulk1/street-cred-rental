import { writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { chat } from '../../server/chat';
import { getComputeDatabase } from '../../server/db';
import { rental } from '../../server/rental';
import { validRentalReply, type RentalReply } from '../../shared/rental';

// Opt-in live OpenAI + real Python HTTP + Neon. All prompts are synthetic;
// a random disposable session is deleted after verification. Never prints credentials.
it.skipIf(process.env.TEST_LIVE_RENTAL_CHAT !== '1')('allows a real chat session to call compute, persist preferences and resume', async () => {
  const token=randomBytes(32).toString('hex');
  const sessionToken=randomBytes(32).toString('hex');
  const key=createHash('sha256').update(sessionToken).digest('hex');
  const port=3019;
  vi.stubEnv('COMPUTE_SERVICE_TOKEN',token);
  vi.stubEnv('COMPUTE_API_URL',`http://127.0.0.1:${port}/api/compute`);
  const child:ChildProcess=spawn('python3',['-c',`from http.server import ThreadingHTTPServer; from api.compute import handler; ThreadingHTTPServer(("127.0.0.1",${port}),handler).serve_forever()`],{
    cwd:process.cwd(),env:process.env,stdio:'ignore',
  });
  let revision=0;
  try {
    let ready=false;
    for(let attempt=0;attempt<50;attempt++) {
      if(child.exitCode!==null) throw new Error('Local Python compute exited before readiness.');
      try { const response=await fetch(`http://127.0.0.1:${port}/api/compute`); if(response.status===405) {ready=true;break;} } catch {}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    expect(ready,'Local compute readiness').toBe(true);
    const response=await chat(new Request('http://local.test/api/chat',{method:'POST',headers:{Authorization:`Bearer ${process.env.CHAT_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({
      messages:[{role:'user',content:'Find a one-bedroom rental near UTS under $800 per week. Use the rental advisor to recommend homes from its snapshot.'}],
      rental:{token:sessionToken,revision:0},eventId:randomUUID(),
    })}));
    expect(response.status).toBe(200);
    const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
    const reply=events.find(e=>e.type==='rental_result')?.rental as RentalReply | undefined;
    console.log(JSON.stringify({verification:'live-chat-compute',toolEvents:events.filter(e=>e.type==='tool').map(e=>({label:e.label,status:e.status})),
      rentalResult:reply ? {action:reply.result.action,revision:reply.revision,recommendations:reply.result.recommendations?.length ?? 0} : null,
      finalEvent:events.at(-1)?.type,answerCharacters:events.filter(e=>e.type==='delta').reduce((n,e)=>n+e.text.length,0),errorCodes:events.filter(e=>e.type==='error').map(e=>e.code)}));
    expect(reply,'Model must actually invoke the rental compute tool').toBeDefined();
    expect(validRentalReply(reply)).toBe(true);
    revision=reply!.revision;
    expect(events.at(-1)?.type).toBe('done');
    expect(events.filter(e=>e.type==='delta').length).toBeGreaterThan(0);
    const rows=await getComputeDatabase().execute(sql`select revision, artifact_version from rental_sessions where token_hash=${key}`);
    expect(rows.rows[0].revision).toBe(revision);
    const explanation=events.filter(e=>e.type==='delta').map(e=>e.text).join('');
    const followup=await chat(new Request('http://local.test/api/chat',{method:'POST',headers:{Authorization:`Bearer ${process.env.CHAT_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({
      messages:[{role:'user',content:'Find a one-bedroom rental near UTS under $800 per week. Use the rental advisor to recommend homes from its snapshot.'},
        {role:'assistant',content:explanation},{role:'user',content:'I also need a furnished home. Update the rental advisor search with this requirement.'}],
      rental:{token:sessionToken,revision},eventId:randomUUID(),
    })}));
    expect(followup.status).toBe(200);
    const followEvents=(await followup.text()).trim().split('\n').map(line=>JSON.parse(line));
    const updated=followEvents.find(e=>e.type==='rental_result')?.rental;
    expect(validRentalReply(updated),'Follow-up must run compute again').toBe(true);
    expect(updated.revision).toBe(revision+1);
    expect(followEvents.at(-1)?.type).toBe('done');
    revision=updated.revision;
    const state=await getComputeDatabase().execute(sql`select state from rental_sessions where token_hash=${key}`);
    expect((state.rows[0].state as any).state.other_confirmed.needs.furnished).toBe(true);
    const resumed=await rental(new Request('http://local.test/api/rental',{method:'POST',headers:{Authorization:`Bearer ${process.env.CHAT_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({
      context:{token:sessionToken,revision},eventId:randomUUID(),command:{operation:'resume'},
    })}));
    expect(resumed.status).toBe(200);
    const next=await resumed.json();
    expect(validRentalReply(next)).toBe(true);
    expect(next.revision).toBe(revision+1);
    const evidence={checkedAt:new Date().toISOString(), liveModel:process.env.OPENAI_MODEL,
      firstTurn:{revision:reply!.revision,action:reply!.result.action,recommendations:reply!.result.recommendations?.length??0},
      followup:{revision,action:updated.result.action,furnishedRequirementPersisted:true},
      resume:{revision:next.revision,action:next.result.action},sessionCleanup:'Disposable session removed in finally'};
    writeFileSync('.build/live-chat-compute-check.json',JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify({verification:'session-resume',revision:next.revision,action:next.result.action}));
  } finally {
    child.kill('SIGTERM');
    await getComputeDatabase().execute(sql`delete from rental_sessions where token_hash=${key}`);
  }
},90000);
