import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyTransport,ReadOnlyTransportError } from '../monitor/readonly-transport.mjs';

const origin='https://demo.example.invalid';
test('read-only transport allows only same-origin GET and forbids redirects',async()=>{
  const calls=[];
  const transport=createReadOnlyTransport({origin,fetchImpl:async(url,options)=>{
    calls.push({url,options});
    return {status:200};
  }});
  const response=await transport('/account?scope=demo');
  assert.equal(response.status,200);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,origin+'/account?scope=demo');
  assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.redirect,'manual');
  assert.equal(calls[0].options.credentials,'omit');
  for(const method of ['POST','PUT','PATCH','DELETE','HEAD','get']) {
    await assert.rejects(transport('/orders',{method}),ReadOnlyTransportError);
  }
  for(const path of ['https://evil.example.invalid/','//evil.example.invalid','/\\evil','/path#fragment']) {
    await assert.rejects(transport(path),ReadOnlyTransportError);
  }
  assert.equal(calls.length,1,'rejected calls must not touch network');
});
test('read-only transport rejects unsafe origins and unexpected redirects',async()=>{
  for(const unsafe of ['http://demo.example.invalid','https://user:pass@demo.example.invalid','https://demo.example.invalid/path','https://demo.example.invalid?x=1','https://demo.example.invalid#frag']) {
    assert.throws(()=>createReadOnlyTransport({origin:unsafe}),ReadOnlyTransportError);
  }
  const transport=createReadOnlyTransport({origin,fetchImpl:async()=>({status:302})});
  await assert.rejects(transport('/account'),ReadOnlyTransportError);
});
test('read-only transport does not retry failed requests or follow redirects',async()=>{
  let calls=0;
  const transport=createReadOnlyTransport({origin,fetchImpl:async()=>{
    calls++;
    throw new Error('network unavailable');
  }});
  await assert.rejects(transport('/account'),/network unavailable/);
  assert.equal(calls,1);
});
