import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoAccountCheckpointStore } from '../monitor/demo-account-checkpoint-store.mjs';
import { createPersistedDemoAccountReader } from '../monitor/persisted-demo-account-reader.mjs';
import { ReadOnlyTransportError } from '../monitor/readonly-transport.mjs';

const now=Date.parse('2026-11-11T06:00:00.000Z');
const base={accountId:'demo_123',environment:'demo',currency:'USD',balance:1000,asOf:'2026-11-11T05:59:30.000Z'};
function response(snapshot) {
  const bytes=new TextEncoder().encode(JSON.stringify(snapshot));
  return {status:200,headers:{get:key=>key==='content-type'?'application/json':null},
    body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})};
}
test('end-to-end checkpoint persists across restart and rejects replay',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'demo-account-e2e-'));
  try {
    const store=createDemoAccountCheckpointStore({filePath:join(dir,'checkpoint.json')});
    const makeReader=snapshot=>createPersistedDemoAccountReader({
      store,transport:async()=>response(snapshot),accountPath:'/account/demo',now:()=>now,
    });
    const first=await makeReader(base);
    assert.deepEqual(await first(),base);
    assert.deepEqual(await store.load(),{accountId:base.accountId,asOf:base.asOf});
    const replay=await makeReader(base);
    await assert.rejects(replay(),ReadOnlyTransportError);
    const newer={...base,asOf:'2026-11-11T05:59:31.000Z'};
    const next=await makeReader(newer);
    assert.deepEqual(await next(),newer);
    assert.deepEqual(await store.load(),{accountId:newer.accountId,asOf:newer.asOf});
    const swapped=await makeReader({...newer,accountId:'different',asOf:'2026-11-11T05:59:32.000Z'});
    await assert.rejects(swapped(),ReadOnlyTransportError);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
