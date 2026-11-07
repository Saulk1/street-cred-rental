import { expect, it, vi } from 'vitest';
import { runRentalCompute } from '../../server/compute';
const url=process.env.TEST_COMPUTE_HTTP_URL;
it.skipIf(url!=='http://127.0.0.1:3001/api/compute')('executes the authenticated local HTTP function against staged artifacts', async()=>{
  vi.stubEnv('COMPUTE_API_URL',url);
  vi.stubEnv('COMPUTE_SERVICE_TOKEN','dummy-compute-http-token-32-characters');
  expect((await fetch(url!,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer wrong'},body:'{}'})).status).toBe(401);
  const first=await runRentalCompute({operation:'start',text:'one bedroom rental under $800 near UTS'},null,null,new AbortController().signal);
  expect(first.result.action).toMatch(/ask|recommend/);
  const next=await runRentalCompute({operation:'resume'},first.state,first.artifactVersion,new AbortController().signal);
  expect(next.result.provenance).toEqual(first.result.provenance);
});
