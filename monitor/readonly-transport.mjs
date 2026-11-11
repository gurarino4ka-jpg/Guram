// CA-60: transport policy for a future read-only demo adapter.
// This module intentionally has no UpScale endpoint, credentials or account access.
export class ReadOnlyTransportError extends Error {
  constructor(message) { super(message); this.name='ReadOnlyTransportError'; }
}

export function createReadOnlyTransport({origin,fetchImpl=globalThis.fetch,timeoutMs=5000,allowedPaths}={}) {
  if(typeof origin!=='string') throw new ReadOnlyTransportError('Explicit HTTPS origin required');
  let allowed;
  try { allowed=new URL(origin); } catch { throw new ReadOnlyTransportError('Invalid origin'); }
  if(allowed.protocol!=='https:'||allowed.username||allowed.password||
     allowed.pathname!=='/'||allowed.search||allowed.hash||
     allowed.origin!==origin.replace(/\/$/,'')) {
    throw new ReadOnlyTransportError('Origin must be an exact HTTPS origin');
  }
  if(!Array.isArray(allowedPaths)||allowedPaths.length===0||
     allowedPaths.some(path=>typeof path!=='string'||!path.startsWith('/')||
       !/^[a-zA-Z0-9/_-]+$/.test(path.slice(1))||
       path.startsWith('//')||path.split('/').some(part=>part==='.'||part==='..'))) {
    throw new ReadOnlyTransportError('Explicit safe path allowlist required');
  }
  const allowedPathSet=new Set(allowedPaths);
  if(allowedPathSet.size!==allowedPaths.length) {
    throw new ReadOnlyTransportError('Duplicate allowlist path');
  }
  if(typeof fetchImpl!=='function') throw new ReadOnlyTransportError('Invalid fetch implementation');
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000) {
    throw new ReadOnlyTransportError('Invalid timeout');
  }
  return async function read(path,{headers={},signal,method='GET'}={}) {
    if(method!=='GET') throw new ReadOnlyTransportError('Mutation methods forbidden');
    if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||
       path.includes('\\')||path.includes('#')||/[\u0000-\u001f\u007f]/.test(path)||
       /%(?:2f|5c|00|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)||
       path.split('?')[0].split('/').some(segment=>{
         let decoded;
         try { decoded=decodeURIComponent(segment); } catch { return true; }
         return decoded==='.'||decoded==='..'||decoded.includes('/')||decoded.includes('\\');
       })) {
      throw new ReadOnlyTransportError('Invalid request path');
    }
    if(!allowedPathSet.has(path)) {
      throw new ReadOnlyTransportError('Request path not allowlisted');
    }
    let url;
    try { url=new URL(path,allowed); } catch { throw new ReadOnlyTransportError('Invalid request path'); }
    if(url.origin!==allowed.origin||url.username||url.password) {
      throw new ReadOnlyTransportError('Cross-origin request forbidden');
    }
    if(!headers||typeof headers!=='object'||Array.isArray(headers)) {
      throw new ReadOnlyTransportError('Invalid headers');
    }
    // Credentials must be handled only by a separately reviewed provider adapter.
    // Do not allow callers to smuggle cookies, tokens or method overrides.
    const entries=Object.entries(headers);
    if(entries.some(([name,value])=>!['accept'].includes(name.toLowerCase())||
       typeof value!=='string'||value!=='application/json')) {
      throw new ReadOnlyTransportError('Request headers not allowlisted');
    }
    if(signal?.aborted) throw new ReadOnlyTransportError('Read-only request aborted');
    const controller=new AbortController();
    let rejectInterrupted;
    const interrupted=new Promise((_resolve,reject)=>{ rejectInterrupted=reject; });
    const abort=()=>{
      if(controller.signal.aborted) return;
      controller.abort();
      rejectInterrupted(new ReadOnlyTransportError('Read-only request aborted'));
    };
    const timer=setTimeout(abort,timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted) abort();
    try {
      let response;
      try {
        if(controller.signal.aborted) throw new ReadOnlyTransportError('Read-only request aborted');
        response=await Promise.race([fetchImpl(url.href,{
          method:'GET',headers:{...headers},redirect:'manual',
          credentials:'omit',signal:controller.signal,
        }),interrupted]);
      } catch {
        // Never expose provider errors: they may contain URLs, tokens or account data.
        throw new ReadOnlyTransportError(controller.signal.aborted?'Read-only request aborted':'Read-only request failed');
      }
      if(controller.signal.aborted) throw new ReadOnlyTransportError('Read-only request aborted');
      if(response?.redirected===true) {
        throw new ReadOnlyTransportError('Redirect forbidden');
      }
      if(typeof response?.url==='string'&&response.url.length>0&&response.url!==url.href) {
        throw new ReadOnlyTransportError('Unexpected response URL');
      }
      if(!response||!Number.isInteger(response.status)||response.status<100||response.status>599) {
        throw new ReadOnlyTransportError('Invalid response');
      }
      if(response.status>=300&&response.status<400) {
        throw new ReadOnlyTransportError('Redirect forbidden');
      }
      if(response.status===401||response.status===403) {
        throw new ReadOnlyTransportError('Read-only authorization rejected');
      }
      if(response.status===429) throw new ReadOnlyTransportError('Read-only rate limit exceeded');
      if(response.status!==200) {
        throw new ReadOnlyTransportError('Read-only HTTP request unsuccessful');
      }
      return response;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
    }
  };
}
