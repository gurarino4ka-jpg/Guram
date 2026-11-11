import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistedDemoAccountReader } from '../monitor/persisted-demo-account-reader.mjs';
import { ReadOnlyTransportError } from '../monitor/readonly-transport.mjs';

const now=Date.parse('2026-11-11T06:00:00.000Z');
const payload={accountId:'demo_123',environment:'demo',currency:'USD',balance:1000,asOf:'2026-11-11T05:59:30.000Z'};
function response(snapshot) {
  return {status:200,headers:{get:key=>key==='content-type'?'application/json':null},
    body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify(snapshot)));controller.close();}})};
}
test('persisted reader saves checkpoint before exposing account snapshot',async()=>{
  let saved=null;
  const store={load:async()=>null,save:async value=>{saved=value;}};
  const read=await createPersistedDemoAccountReader({store,transport:async()=>response(payload),
    accountPath:'/account/demo',now:()=>now});
  assert.equal(saved,null);
  const result=await read();
  assert.deepEqual(result,payload);
  assert.deepEqual(saved,{accountId:payload.accountId,asOf:payload.asOf});
});
test('persisted reader fails closed when restore or save fails',async()=>{
  await assert.rejects(createPersistedDemoAccountReader({
    store:{load:async()=>{throw new Error('secret');},save:async()=>{}},
    transport:async()=>response(payload),accountPath:'/account/demo',now:()=>now,
  }),ReadOnlyTransportError);
  const read=await createPersistedDemoAccountReader({
    store:{load:async()=>null,save:async()=>{throw new Error('secret');}},
    transport:async()=>response(payload),accountPath:'/account/demo',now:()=>now,
  });
  await assert.rejects(read(),error=>{
    assert.equal(error instanceof ReadOnlyTransportError,true);
    assert.equal(error.message.includes('secret'),false);
    return true;
  });
});
test('restored checkpoint prevents replay through persisted reader',async()=>{
  const checkpoint={accountId:payload.accountId,asOf:payload.asOf};
  const read=await createPersistedDemoAccountReader({
    store:{load:async()=>checkpoint,save:async()=>{}},
    transport:async()=>response(payload),accountPath:'/account/demo',now:()=>now,
  });
  await assert.rejects(read(),ReadOnlyTransportError);
});

test('checkpoint save failure permanently disables reader until a new instance is created',async()=>{
  let calls=0;
  let saves=0;
  const store={load:async()=>null,save:async()=>{saves++;throw new Error('disk full');}};
  const read=await createPersistedDemoAccountReader({
    store,transport:async()=>{calls++;return response(payload);},
    accountPath:'/account/demo',now:()=>now,
  });
  await assert.rejects(read(),ReadOnlyTransportError);
  await assert.rejects(read(),error=>{
    assert.match(error.message,/requires restart/);
    return true;
  });
  assert.equal(calls,1);
  assert.equal(saves,1);
});

test('persisted reader rejects overlapping reads while checkpoint save is pending',async()=>{
  let releaseSave;
  let enteredSave;
  const saving=new Promise(resolve=>{enteredSave=resolve;});
  const waitForRelease=new Promise(resolve=>{releaseSave=resolve;});
  let transportCalls=0;
  const read=await createPersistedDemoAccountReader({
    store:{load:async()=>null,save:async()=>{enteredSave();await waitForRelease;}},
    transport:async()=>{transportCalls++;return response(payload);},
    accountPath:'/account/demo',now:()=>now,
  });
  const first=read();
  await saving;
  await assert.rejects(read(),error=>{
    assert.match(error.message,/Concurrent persisted read/);
    return true;
  });
  assert.equal(transportCalls,1);
  releaseSave();
  assert.deepEqual(await first,payload);
});

test('restart restores durable checkpoint and rejects replay before accepting newer snapshot',async()=>{
  let persisted=null;
  const store={
    load:async()=>persisted,
    save:async value=>{persisted={...value};},
  };
  const makeReader=snapshot=>createPersistedDemoAccountReader({
    store,transport:async()=>response(snapshot),
    accountPath:'/account/demo',now:()=>now,
  });
  const first=await makeReader(payload);
  assert.deepEqual(await first(),payload);
  assert.deepEqual(persisted,{accountId:payload.accountId,asOf:payload.asOf});
  const restarted=await makeReader(payload);
  await assert.rejects(restarted(),ReadOnlyTransportError);
  const newer={...payload,asOf:'2026-11-11T05:59:31.000Z'};
  const next=await makeReader(newer);
  assert.deepEqual(await next(),newer);
  assert.deepEqual(persisted,{accountId:newer.accountId,asOf:newer.asOf});
});
