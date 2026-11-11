import { ReadOnlyTransportError } from './readonly-transport.mjs';
import { parseDemoAccountSnapshot } from './demo-account-validation.mjs';

// Provider-neutral composition only. Do not wire to an actual account until
// the official demo API contract and read-only credentials are reviewed.
export function createDemoAccountReader({transport,accountPath,now=()=>Date.now(),maxBytes=16384,bodyTimeoutMs=5000,checkpoint=null}={}) {
  if(typeof transport!=='function') throw new ReadOnlyTransportError('Read-only transport required');
  if(typeof accountPath!=='string'||!/^\/[a-zA-Z0-9/_-]+$/.test(accountPath)||
     accountPath.startsWith('//')||accountPath.split('/').some(part=>part==='.'||part==='..')) {
    throw new ReadOnlyTransportError('Explicit account path required');
  }
  if(typeof now!=='function'||!Number.isInteger(maxBytes)||maxBytes<256||maxBytes>1048576||
     !Number.isInteger(bodyTimeoutMs)||bodyTimeoutMs<100||bodyTimeoutMs>30000) {
    throw new ReadOnlyTransportError('Invalid reader configuration');
  }
  // Caller may restore a previously persisted checkpoint; this module does not write to disk.
  if(checkpoint!==null&&(
    !checkpoint||typeof checkpoint!=='object'||Array.isArray(checkpoint)||
    Object.keys(checkpoint).sort().join(',')!=='accountId,asOf'||
    typeof checkpoint.accountId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(checkpoint.accountId)||
    typeof checkpoint.asOf!=='string'||!Number.isFinite(Date.parse(checkpoint.asOf))||
    new Date(Date.parse(checkpoint.asOf)).toISOString()!==checkpoint.asOf
  )) throw new ReadOnlyTransportError('Invalid account checkpoint');
  let lastAcceptedTimestamp=checkpoint===null?-Infinity:Date.parse(checkpoint.asOf);
  let pinnedAccountId=checkpoint===null?null:checkpoint.accountId;
  let inFlight=false;
  async function readDemoAccount({signal}={}) {
    if(inFlight) throw new ReadOnlyTransportError('Concurrent account read forbidden');
    inFlight=true;
    try {
    let response;
    try { response=await transport(accountPath,{method:'GET',signal}); }
    catch { throw new ReadOnlyTransportError('Account request failed'); }
    let declaredLength;
    try {
      if(response?.status!==200) throw new ReadOnlyTransportError('Unexpected account HTTP status');
      declaredLength=response?.headers?.get?.('content-length');
      if(declaredLength!==null&&declaredLength!==undefined) {
        if(typeof declaredLength!=='string'||!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)||!Number.isSafeInteger(Number(declaredLength))||Number(declaredLength)>maxBytes) {
          throw new ReadOnlyTransportError('Account response too large');
        }
      }
      const contentType=response?.headers?.get?.('content-type');
      if(typeof contentType!=='string'||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
        throw new ReadOnlyTransportError('Account response must be JSON');
      }
    } catch {
      throw new ReadOnlyTransportError('Invalid account response headers');
    }
    let raw;
    let observedBytes=0;
    if(signal?.aborted) throw new ReadOnlyTransportError('Account read aborted');
    try {
      // Limit streaming bytes, not just Content-Length or post-buffer length.
      if(!response.body||typeof response.body.getReader!=='function') {
        throw new Error('Streaming response required');
      }
      const reader=response.body.getReader();
      let timeout;
      let onAbort;
      const interrupted=new Promise((_resolve,reject)=>{
        timeout=setTimeout(()=>reject(new ReadOnlyTransportError('Account body timeout')),bodyTimeoutMs);
        if(signal) {
          onAbort=()=>reject(new ReadOnlyTransportError('Account read aborted'));
          signal.addEventListener('abort',onAbort,{once:true});
          if(signal.aborted) onAbort();
        }
      });
      const chunks=[];
      let size=0;
      try {
        while(true) {
          const {done,value}=await Promise.race([reader.read(),interrupted]);
          if(done) break;
          if(!(value instanceof Uint8Array)) throw new Error('Invalid stream chunk');
          size+=value.byteLength;
          observedBytes=size;
          if(size>maxBytes) throw new ReadOnlyTransportError('Account response too large');
          chunks.push(value);
        }
      } finally {
        clearTimeout(timeout);
        if(signal&&onAbort) signal.removeEventListener('abort',onAbort);
        try { reader.cancel().catch(()=>{}); } catch {}
        reader.releaseLock();
      }
      const bytes=new Uint8Array(size);
      let offset=0;
      for(const chunk of chunks) { bytes.set(chunk,offset);offset+=chunk.byteLength; }
      raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    } catch {
      throw new ReadOnlyTransportError('Invalid account response body');
    }
    if(declaredLength!==null&&declaredLength!==undefined&&Number(declaredLength)!==observedBytes) {
      throw new ReadOnlyTransportError('Incomplete account response');
    }
    let payload;
    try { payload=JSON.parse(raw); }
    catch { throw new ReadOnlyTransportError('Invalid account JSON'); }
    let snapshot;
    try { snapshot=parseDemoAccountSnapshot(payload,{now:now()}); }
    catch { throw new ReadOnlyTransportError('Invalid demo account snapshot'); }
    const timestamp=Date.parse(snapshot.asOf);
    if(timestamp<=lastAcceptedTimestamp) {
      throw new ReadOnlyTransportError('Non-increasing account snapshot timestamp');
    }
    if(pinnedAccountId!==null&&snapshot.accountId!==pinnedAccountId) {
      throw new ReadOnlyTransportError('Unexpected demo account identity');
    }
    pinnedAccountId=snapshot.accountId;
    lastAcceptedTimestamp=timestamp;
    return snapshot;
    } finally { inFlight=false; }
  }
  readDemoAccount.getCheckpoint=()=>pinnedAccountId===null?null:Object.freeze({accountId:pinnedAccountId,asOf:new Date(lastAcceptedTimestamp).toISOString()});
  return readDemoAccount;
}
