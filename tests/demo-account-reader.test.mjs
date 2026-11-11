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
  const transport=createReadOnlyTransport({origin,fetchImpl:async(url,options)=>{
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
    const transport=createReadOnlyTransport({origin,fetchImpl:async()=>response});
    const read=createDemoAccountReader({transport,accountPath:'/account/demo',now:()=>now,maxBytes:512});
    await assert.rejects(read(),ReadOnlyTransportError);
  }
});
test('reader configuration rejects unsafe account paths',()=>{
  const transport=async()=>fakeResponse(payload);
  for(const accountPath of ['https://elsewhere.example','//evil','/../account','/account#token','/account\\live','']) {
    assert.throws(()=>createDemoAccountReader({transport,accountPath}),ReadOnlyTransportError);
  }
});
