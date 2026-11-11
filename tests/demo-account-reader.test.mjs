import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyTransport,ReadOnlyTransportError } from '../monitor/readonly-transport.mjs';
import { createDemoAccountReader } from '../monitor/demo-account-reader.mjs';

const origin='https://demo.example.invalid';
const now=Date.parse('2026-11-11T06:00:00.000Z');
const payload={accountId:'demo_123',environment:'demo',currency:'USD',balance:1000,asOf:'2026-11-11T05:59:30.000Z'};
function fakeResponse(data,headers={'content-type':'application/json'}) {
  const encoded=new TextEncoder().encode(typeof data==='string'?data:JSON.stringify(data));
  return {status:200,headers:{get:key=>headers[key]??null},body:new ReadableStream({
    start(controller) { controller.enqueue(encoded);controller.close(); },
  })};
}
test('synthetic demo account GET validates full pipeline without mutations',async()=>{
  const requests=[];
  const transport=createReadOnlyTransport({origin,allowedPaths:['/account','/account/demo'],fetchImpl:async(url,options)=>{
    requests.push({url,options});
    return fakeResponse(payload);
  }});
  const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now});
  const account=await read();
  assert.deepEqual(account,payload);
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,origin+'/account/demo');
  assert.equal(requests[0].options.method,'GET');
  assert.equal(requests[0].options.redirect,'manual');
});
test('rejects live account, malformed JSON, oversized body and invalid MIME',async()=>{
  const cases=[
    fakeResponse({...payload,environment:'live'}),
    fakeResponse('{not-json'),
    fakeResponse('x'.repeat(2000)),
    fakeResponse(payload,{'content-type':'text/html'}),
    fakeResponse(payload,{'content-type':'application/json','content-length':'99999'}),
  ];
  for(const response of cases) {
    const transport=createReadOnlyTransport({origin,allowedPaths:['/account','/account/demo'],fetchImpl:async()=>response});
    const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now,maxBytes:512});
    await assert.rejects(read(),ReadOnlyTransportError);
  }
});
test('reader configuration rejects unsafe account paths',()=>{
  const transport=async()=>fakeResponse(payload);
  for(const accountPath of ['https://elsewhere.example','//evil','/../account','/account#token','/account\\live','/account?scope=demo','/account%2Fdemo','/account/./demo','/account/../demo','']) {
    assert.throws(()=>createDemoAccountReader({transport,accountPath}),ReadOnlyTransportError);
  }
});

test('rejects truncated Content-Length, broken stream and invalid UTF-8',async()=>{
  const text=JSON.stringify(payload);
  const bytes=new TextEncoder().encode(text);
  const cases=[
    {status:200,headers:{get:key=>key==='content-type'?'application/json':key==='content-length'?String(bytes.length+1):null},
      body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})},
    {status:200,headers:{get:key=>key==='content-type'?'application/json':null},
      body:new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,10));controller.error(new Error('secret provider error'));}})},
    {status:200,headers:{get:key=>key==='content-type'?'application/json':null},
      body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array([0xff,0xfe]));controller.close();}})},
  ];
  for(const response of cases) {
    const transport=createReadOnlyTransport({origin,allowedPaths:['/account','/account/demo'],fetchImpl:async()=>response});
    const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now});
    await assert.rejects(read(),ReadOnlyTransportError);
  }
});
test('pre-aborted read rejects without producing an accepted account snapshot',async()=>{
  const controller=new AbortController();
  controller.abort();
  const transport=createReadOnlyTransport({origin,allowedPaths:['/account','/account/demo'],fetchImpl:async(_url,{signal})=>{
    if(signal.aborted) throw new Error('secret from provider');
    return fakeResponse(payload);
  }});
  const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now});
  await assert.rejects(read({signal:controller.signal}),ReadOnlyTransportError);
});

test('stalled streaming body times out and never returns a partial balance',async()=>{
  const response={status:200,headers:{get:key=>key==='content-type'?'application/json':null},
    body:new ReadableStream({pull(){return new Promise(()=>{});}})};
  const transport=createReadOnlyTransport({origin,allowedPaths:['/account/demo'],fetchImpl:async()=>response});
  const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now,bodyTimeoutMs:100});
  await assert.rejects(read(),ReadOnlyTransportError);
});
test('abort during streaming body rejects without a snapshot',async()=>{
  const controller=new AbortController();
  const response={status:200,headers:{get:key=>key==='content-type'?'application/json':null},
    body:new ReadableStream({pull(){return new Promise(()=>{});}})};
  const transport=createReadOnlyTransport({origin,allowedPaths:['/account/demo'],fetchImpl:async()=>response});
  const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now,bodyTimeoutMs:1000});
  const pending=read({signal:controller.signal});
  controller.abort();
  await assert.rejects(pending,ReadOnlyTransportError);
});

test('reader configuration rejects query strings and encoded path tricks',()=>{
  const transport=async()=>fakeResponse(payload);
  for(const accountPath of ['/account?scope=demo','/account%2fdemo','/account%2e%2e','/account/./demo','/account/../demo']) {
    assert.throws(()=>createDemoAccountReader({transport,accountPath}),ReadOnlyTransportError);
  }
});

test('provider exceptions never leak secret text through reader errors',async()=>{
  const secret='PRIVATE_PROVIDER_TOKEN_123';
  const cases=[
    async()=>{throw new Error(secret);},
    async()=>({headers:{get(){throw new Error(secret);}}}),
    async()=>fakeResponse({...payload,environment:'live',accountId:secret}),
  ];
  for(const transport of cases) {
    const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now});
    await assert.rejects(read(),error=>{
      assert.equal(error instanceof ReadOnlyTransportError,true);
      assert.equal(error.message.includes(secret),false);
      return true;
    });
  }
});

test('cancels the underlying body stream after timeout',async()=>{
  let cancellations=0;
  const response={status:200,headers:{get:key=>key==='content-type'?'application/json':null},
    body:new ReadableStream({
      start(controller){controller.enqueue(new TextEncoder().encode('{"accountId":'));},
      pull(){return new Promise(()=>{});},
      cancel(){cancellations++;}
    })};
  const transport=createReadOnlyTransport({origin,allowedPaths:['/account/demo'],fetchImpl:async()=>response});
  const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now,bodyTimeoutMs:100});
  await assert.rejects(read(),ReadOnlyTransportError);
  assert.equal(cancellations,1);
});
test('cancels the underlying body stream when byte limit is exceeded',async()=>{
  let cancellations=0;
  const response={status:200,headers:{get:key=>key==='content-type'?'application/json':null},
    body:new ReadableStream({
      start(controller){controller.enqueue(new Uint8Array(513));},
      cancel(){cancellations++;}
    })};
  const transport=createReadOnlyTransport({origin,allowedPaths:['/account/demo'],fetchImpl:async()=>response});
  const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now,maxBytes:512});
  await assert.rejects(read(),ReadOnlyTransportError);
  assert.equal(cancellations,1);
});

test('reader rejects non-200 responses even from an injected custom transport',async()=>{
  for(const status of [undefined,0,201,204,206,301,401,500]) {
    const transport=async()=>({status,headers:{get:key=>key==='content-type'?'application/json':null},
      body:new ReadableStream({start(controller){controller.close();}})});
    const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now});
    await assert.rejects(read(),ReadOnlyTransportError,String(status));
  }
});

test('rejects noncanonical and unsafe Content-Length values',async()=>{
  for(const length of ['00','01','0001','+1','1.0','1e2','9007199254740993','999999999999999999999999999999','-1',' 1','1 ','1, 2']) {
    const transport=async()=>({status:200,headers:{get:key=>key==='content-type'?'application/json':key==='content-length'?length:null}});
    const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now});
    await assert.rejects(read(),ReadOnlyTransportError,length);
  }
});

test('rejects non-JSON and misleading Content-Type parameters',async()=>{
  for(const contentType of ['text/html','application/jsonp','application/json; charset=iso-8859-1',
    'application/json; boundary=evil','application/json; charset=utf-8; boundary=evil',
    'application/json, text/html','application/json; charset=utf-16','application/json; charset=utf-8\r\nX-Evil: yes']) {
    const transport=async()=>({status:200,headers:{get:key=>key==='content-type'?contentType:null}});
    const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now});
    await assert.rejects(read(),ReadOnlyTransportError,contentType);
  }
});

test('rejects replayed and regressed account snapshots',async()=>{
  const snapshots=[
    {...payload,asOf:'2026-11-11T05:59:30.000Z'},
    {...payload,asOf:'2026-11-11T05:59:30.000Z'},
    {...payload,asOf:'2026-11-11T05:59:29.000Z'},
    {...payload,asOf:'2026-11-11T05:59:31.000Z'},
  ];
  const transport=async()=>fakeResponse(snapshots.shift());
  const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now});
  assert.equal((await read()).balance,1000);
  await assert.rejects(read(),ReadOnlyTransportError);
  await assert.rejects(read(),ReadOnlyTransportError);
  assert.equal((await read()).asOf,'2026-11-11T05:59:31.000Z');
});
test('pins account identity after first accepted snapshot',async()=>{
  const snapshots=[
    {...payload},
    {...payload,accountId:'demo_other',asOf:'2026-11-11T05:59:31.000Z'},
  ];
  const read=createDemoAccountReader({transport:async()=>fakeResponse(snapshots.shift()),
    accountPath:'/account/demo',now:()=>now});
  await read();
  await assert.rejects(read(),ReadOnlyTransportError);
});

test('rejects concurrent reads and releases lock after completion',async()=>{
  let finish;
  let calls=0;
  const transport=async()=>{
    calls++;
    if(calls===1) await new Promise(resolve=>{finish=resolve;});
    return fakeResponse({...payload,asOf:calls===1?'2026-11-11T05:59:30.000Z':'2026-11-11T05:59:31.000Z'});
  };
  const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now});
  const first=read();
  await assert.rejects(read(),ReadOnlyTransportError);
  assert.equal(calls,1);
  finish();
  assert.equal((await first).balance,1000);
  assert.equal((await read()).asOf,'2026-11-11T05:59:31.000Z');
  assert.equal(calls,2);
});
test('releases reader lock after transport failure',async()=>{
  let calls=0;
  const read=createDemoAccountReader({transport:async()=>{
    calls++;
    if(calls===1) throw new Error('provider failure');
    return fakeResponse(payload);
  },accountPath:'/account/demo',now:()=>now});
  await assert.rejects(read(),ReadOnlyTransportError);
  assert.equal((await read()).balance,1000);
});

test('restored checkpoint rejects replay after simulated restart',async()=>{
  const read1=createDemoAccountReader({transport:async()=>fakeResponse(payload),
    accountPath:'/account/demo',now:()=>now});
  assert.equal(read1.getCheckpoint(),null);
  await read1();
  const checkpoint=read1.getCheckpoint();
  assert.deepEqual(checkpoint,{accountId:'demo_123',asOf:payload.asOf});
  assert.equal(Object.isFrozen(checkpoint),true);
  const read2=createDemoAccountReader({transport:async()=>fakeResponse(payload),
    accountPath:'/account/demo',now:()=>now,checkpoint});
  await assert.rejects(read2(),ReadOnlyTransportError);
  assert.deepEqual(read2.getCheckpoint(),checkpoint);
});
test('restored checkpoint permits newer snapshot for same account',async()=>{
  const checkpoint={accountId:'demo_123',asOf:payload.asOf};
  const newer={...payload,asOf:'2026-11-11T05:59:31.000Z'};
  const read=createDemoAccountReader({transport:async()=>fakeResponse(newer),
    accountPath:'/account/demo',now:()=>now,checkpoint});
  assert.equal((await read()).asOf,newer.asOf);
  assert.deepEqual(read.getCheckpoint(),{accountId:'demo_123',asOf:newer.asOf});
});
test('rejects malformed restored checkpoints',()=>{
  const transport=async()=>fakeResponse(payload);
  for(const checkpoint of [{},{accountId:'demo_123'}, {accountId:'../live',asOf:payload.asOf},
    {accountId:'demo_123',asOf:'invalid'}, {accountId:'demo_123',asOf:payload.asOf,extra:true},[]]) {
    assert.throws(()=>createDemoAccountReader({transport,accountPath:'/account/demo',checkpoint}),ReadOnlyTransportError);
  }
});
