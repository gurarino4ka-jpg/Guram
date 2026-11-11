import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyTransport,ReadOnlyTransportError } from '../monitor/readonly-transport.mjs';

const origin='https://demo.example.invalid';
test('read-only transport allows only same-origin GET and forbids redirects',async()=>{
  const calls=[];
  const transport=createReadOnlyTransport({origin,allowedPaths:['/account','/account/demo'],fetchImpl:async(url,options)=>{
    calls.push({url,options});
    return {status:200};
  }});
  const response=await transport('/account');
  assert.equal(response.status,200);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,origin+'/account');
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
  await assert.rejects(transport('/orders'),ReadOnlyTransportError);
  assert.equal(calls.length,1);
});
test('read-only transport rejects unsafe origins and unexpected redirects',async()=>{
  for(const unsafe of ['http://demo.example.invalid','https://user:pass@demo.example.invalid','https://demo.example.invalid/path','https://demo.example.invalid?x=1','https://demo.example.invalid#frag']) {
    assert.throws(()=>createReadOnlyTransport({origin:unsafe,allowedPaths:['/account']}),ReadOnlyTransportError);
  }
  const transport=createReadOnlyTransport({origin,allowedPaths:['/account','/account/demo'],fetchImpl:async()=>({status:302})});
  await assert.rejects(transport('/account'),ReadOnlyTransportError);
});
test('read-only transport does not retry failed requests or follow redirects',async()=>{
  let calls=0;
  const transport=createReadOnlyTransport({origin,allowedPaths:['/account','/account/demo'],fetchImpl:async()=>{
    calls++;
    throw new Error('network unavailable');
  }});
  await assert.rejects(transport('/account'),/Read-only request failed/);
  assert.equal(calls,1);
});

test('sanitizes secrets in network errors and rejects HTTP failure statuses',async()=>{
  const secret='token-never-leak';
  const failed=createReadOnlyTransport({origin,allowedPaths:['/account','/account/demo'],fetchImpl:async()=>{
    throw new Error('Authorization '+secret);
  }});
  await assert.rejects(failed('/account'),error=>{
    assert.equal(error instanceof ReadOnlyTransportError,true);
    assert.equal(error.message.includes(secret),false);
    return true;
  });
  for(const [status,fragment] of [[401,'authorization'],[403,'authorization'],[429,'rate limit'],[500,'unsuccessful'],[302,'Redirect']]) {
    const transport=createReadOnlyTransport({origin,allowedPaths:['/account','/account/demo'],fetchImpl:async()=>({status})});
    await assert.rejects(transport('/account'),error=>error instanceof ReadOnlyTransportError&&error.message.includes(fragment));
  }
});
test('aborted request fails closed without retry',async()=>{
  let calls=0;
  const transport=createReadOnlyTransport({origin,allowedPaths:['/account','/account/demo'],timeoutMs:100,fetchImpl:async(_url,{signal})=>{
    calls++;
    return new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(new Error('private token in abort')), {once:true});
    });
  }});
  await assert.rejects(transport('/account'),/Read-only request aborted/);
  assert.equal(calls,1);
});

test('rejects encoded path traversal and separators before any request',async()=>{
  let calls=0;
  const read=createReadOnlyTransport({origin,allowedPaths:['/account','/account/demo'],fetchImpl:async()=>{
    calls++;
    return {status:200};
  }});
  for(const path of [
    '/account/../private','/account/%2e%2e/private','/%2E/private',
    '/account/%2fprivate','/account/%5cprivate','/account/%00',
    '/account/%2e./private','/account/%ZZ','/account\nprivate',
  ]) {
    await assert.rejects(read(path),ReadOnlyTransportError,path);
  }
  assert.equal(calls,0);
});

test('requires a safe explicit endpoint allowlist',async()=>{
  assert.throws(()=>createReadOnlyTransport({origin}),ReadOnlyTransportError);
  for(const allowedPaths of [[],['/account','/account'],['/account?query=1'],['/orders/../account'],['//evil']]) {
    assert.throws(()=>createReadOnlyTransport({origin,allowedPaths}),ReadOnlyTransportError);
  }
  let calls=0;
  const read=createReadOnlyTransport({origin,allowedPaths:['/account'],fetchImpl:async()=>{
    calls++;
    return {status:200};
  }});
  await assert.rejects(read('/orders'),ReadOnlyTransportError);
  await assert.rejects(read('/account?query=1'),ReadOnlyTransportError);
  assert.equal(calls,0);
});

test('rejects credentials, cookies, custom headers and method overrides before network',async()=>{
  let calls=0;
  const read=createReadOnlyTransport({origin,allowedPaths:['/account'],fetchImpl:async()=>{
    calls++;
    return {status:200};
  }});
  for(const headers of [
    {Authorization:'Bearer private-token'},
    {Cookie:'session=secret'},
    {'X-HTTP-Method-Override':'POST'},
    {'Proxy-Authorization':'Basic private'},
    {'Accept':'text/html'},
    {'Accept':'application/json','X-Custom':'value'},
  ]) {
    await assert.rejects(read('/account',{headers}),ReadOnlyTransportError);
  }
  await read('/account',{headers:{Accept:'application/json'}});
  assert.equal(calls,1);
});
