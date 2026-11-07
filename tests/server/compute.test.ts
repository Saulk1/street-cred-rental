import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { computeSettings, computationTools, runRentalCompute } from '../../server/compute';
import { validRentalResult } from '../../shared/rental';
beforeEach(() => {
  vi.stubEnv('COMPUTE_API_URL', 'https://compute.example.test/api/compute');
  vi.stubEnv('COMPUTE_SERVICE_TOKEN', 'dummy-compute-token-32-characters-long');
});
export const result = { action: 'no_match', reason_code: 'no_feasible_listing', provenance: {
  snapshotDate: '2026-11-07T01:10:58Z', artifactVersion: 'a'.repeat(64), modelVersion: 'test-model', advisorVersion: '1.0.0' }, warnings: ['Dated snapshot.'] };
it('exposes only the advisor tool', () => {
  expect(computationTools).toHaveLength(1);
  expect(computationTools[0]).toMatchObject({ name: 'compute_rental_advisor', parameters: { properties: {} } });
});
it('bounds and authenticates compute requests and validates structured replies', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ calculator: 'rental_advisor', version:'1.0.0', status:'ok', state:{schema:1}, artifactVersion:'a'.repeat(64), result }));
  const reply = await runRentalCompute({operation:'start',text:'budget 800'},null,null,new AbortController().signal);
  expect(validRentalResult(reply.result)).toBe(true);
  expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'error',credentials:'omit'});
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({calculator:'rental_advisor',state:null});
});
it('preserves safe remote codes and rejects malformed outputs', async () => {
  const fetcher=vi.spyOn(globalThis,'fetch');
  fetcher.mockResolvedValueOnce(Response.json({error:{code:'stale_snapshot',message:'private secret'}},{status:400}));
  await expect(runRentalCompute({operation:'resume'},null,null,new AbortController().signal)).rejects.toMatchObject({code:'stale_snapshot'});
  fetcher.mockResolvedValueOnce(Response.json({secret:'never display'}));
  await expect(runRentalCompute({operation:'resume'},null,null,new AbortController().signal)).rejects.toMatchObject({code:'response'});
});
it('rejects invalid endpoints, missing configuration and expired deadlines', async () => {
  for (const url of ['http://remote.test/api/compute','https://compute.test/other','https://user:pass@compute.test/api/compute']) {
    vi.stubEnv('COMPUTE_API_URL',url);expect(()=>computeSettings()).toThrow();
  }
  vi.stubEnv('COMPUTE_API_URL','https://compute.test/api/compute');
  await expect(runRentalCompute({operation:'resume'},null,null,new AbortController().signal,Date.now())).rejects.toMatchObject({code:'timeout'});
});

it.skipIf(!existsSync('.private/rental/manifest.json'))('runs the real Python adapter and restores its serialized state', async () => {
  vi.spyOn(globalThis,'fetch').mockImplementation(async (_url,init) => {
    const raw = execFileSync('python3',['-c','import json,sys;from compute.registry import run;print(json.dumps(run(json.load(sys.stdin))))'],{input:init!.body as string});
    return Response.json(JSON.parse(raw.toString()));
  });
  const first=await runRentalCompute({operation:'start',text:'one bedroom budget $800 per week near UTS'},null,null,new AbortController().signal);
  expect(validRentalResult(first.result)).toBe(true);
  const resumed=await runRentalCompute({operation:'resume'},first.state,first.artifactVersion,new AbortController().signal);
  expect(resumed.result.provenance).toEqual(first.result.provenance);
});
