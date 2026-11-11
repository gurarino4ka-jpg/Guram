// CA-60: transport policy for a future read-only demo adapter.
// This module intentionally has no UpScale endpoint, credentials or account access.
export class ReadOnlyTransportError extends Error {
  constructor(message) { super(message); this.name='ReadOnlyTransportError'; }
}

export function createReadOnlyTransport({origin,fetchImpl=globalThis.fetch,timeoutMs=5000}={}) {
  if(typeof origin!=='string') throw new ReadOnlyTransportError('Explicit HTTPS origin required');
  let allowed;
  try { allowed=new URL(origin); } catch { throw new ReadOnlyTransportError('Invalid origin'); }
  if(allowed.protocol!=='https:'||allowed.username||allowed.password||
     allowed.pathname!=='/'||allowed.search||allowed.hash||
     allowed.origin!==origin.replace(/\/$/,'')) {
    throw new ReadOnlyTransportError('Origin must be an exact HTTPS origin');
  }
  if(typeof fetchImpl!=='function') throw new ReadOnlyTransportError('Invalid fetch implementation');
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000) {
    throw new ReadOnlyTransportError('Invalid timeout');
  }
  return async function read(path,{headers={},signal,method='GET'}={}) {
    if(method!=='GET') throw new ReadOnlyTransportError('Mutation methods forbidden');
    if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||
       path.includes('\\')||path.includes('#')) {
      throw new ReadOnlyTransportError('Invalid request path');
    }
    let url;
    try { url=new URL(path,allowed); } catch { throw new ReadOnlyTransportError('Invalid request path'); }
    if(url.origin!==allowed.origin||url.username||url.password) {
      throw new ReadOnlyTransportError('Cross-origin request forbidden');
    }
    if(!headers||typeof headers!=='object'||Array.isArray(headers)) {
      throw new ReadOnlyTransportError('Invalid headers');
    }
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    const abort=()=>controller.abort();
    if(signal?.aborted) controller.abort();
    else signal?.addEventListener('abort',abort,{once:true});
    try {
      const response=await fetchImpl(url.href,{
        method:'GET',headers:{...headers},redirect:'manual',
        credentials:'omit',signal:controller.signal,
      });
      if(!response||typeof response.status!=='number') {
        throw new ReadOnlyTransportError('Invalid response');
      }
      if(response.status>=300&&response.status<400) {
        throw new ReadOnlyTransportError('Redirect forbidden');
      }
      return response;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
    }
  };
}
