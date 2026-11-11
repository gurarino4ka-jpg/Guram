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
