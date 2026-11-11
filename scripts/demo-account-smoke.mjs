#!/usr/bin/env node
// SYNTHETIC demo only. No network, tokens, API keys or trading operations.
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoAccountCheckpointStore } from '../monitor/demo-account-checkpoint-store.mjs';
import { createPersistedDemoAccountReader } from '../monitor/persisted-demo-account-reader.mjs';
import { ReadOnlyTransportError } from '../monitor/readonly-transport.mjs';

const fake={
  accountId:'fixture_demo_001',
  environment:'demo',
  currency:'USD',
  balance:10000,
  asOf:'2026-11-11T05:59:30.000Z',
};
const dir=await mkdtemp(join(tmpdir(),'read-only-demo-smoke-'));
try {
  const filePath=join(dir,'checkpoint.json');
  const store=createDemoAccountCheckpointStore({filePath});
  const mockGet=async(path,{method}={})=>{
    assert.equal(path,'/account/demo');
    assert.equal(method,'GET');
    return new Response(JSON.stringify(fake),{
      status:200,
      headers:{'Content-Type':'application/json'},
    });
  };
  const makeReader=()=>createPersistedDemoAccountReader({
    store,transport:mockGet,accountPath:'/account/demo',
    now:()=>Date.parse('2026-11-11T06:00:00.000Z'),
  });
  const first=await makeReader();
  const snapshot=await first();
  assert.deepEqual(snapshot,fake);
  console.log('SYNTHETIC DEMO ACCOUNT — NOT UPSCALE');
  console.log('Account:',snapshot.accountId);
  console.log('Virtual balance:',snapshot.balance,snapshot.currency);
  console.log('As of:',snapshot.asOf);
  const afterRestart=await makeReader();
  await assert.rejects(afterRestart(),ReadOnlyTransportError);
  console.log('Checkpoint persisted: yes');
  console.log('Replay after restart: blocked');
  console.log('Network/API/order operations: none');
} finally {
  await rm(dir,{recursive:true,force:true});
}
