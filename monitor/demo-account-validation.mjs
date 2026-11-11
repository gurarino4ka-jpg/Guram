import { ReadOnlyTransportError } from './readonly-transport.mjs';

// Provider-neutral, strict parsing of read-only demo account snapshots.
// No UpScale schema is assumed: mapping requires official API documentation.
export function parseDemoAccountSnapshot(payload,{now=Date.now(),maxAgeMs=120000}={}) {
  if(!payload||typeof payload!=='object'||Array.isArray(payload)) {
    throw new ReadOnlyTransportError('Invalid account snapshot');
  }
  const keys=Object.keys(payload);
  if(keys.some(key=>!['accountId','environment','currency','balance','asOf'].includes(key))) {
    throw new ReadOnlyTransportError('Unexpected account snapshot fields');
  }
  if(typeof payload.accountId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(payload.accountId)) {
    throw new ReadOnlyTransportError('Invalid account identity');
  }
  if(payload.environment!=='demo') throw new ReadOnlyTransportError('Not a demo account');
  if(typeof payload.currency!=='string'||!/^[A-Z]{3,8}$/.test(payload.currency)) {
    throw new ReadOnlyTransportError('Invalid balance currency');
  }
  if(typeof payload.balance!=='number'||!Number.isFinite(payload.balance)||payload.balance<0) {
    throw new ReadOnlyTransportError('Invalid balance');
  }
  if(typeof payload.asOf!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(payload.asOf)) {
    throw new ReadOnlyTransportError('Invalid timestamp');
  }
  const timestamp=Date.parse(payload.asOf);
  if(!Number.isFinite(timestamp)||new Date(timestamp).toISOString()!==payload.asOf) {
    throw new ReadOnlyTransportError('Noncanonical timestamp');
  }
  if(!Number.isFinite(now)||!Number.isInteger(maxAgeMs)||maxAgeMs<0||
      timestamp>now+5000||now-timestamp>maxAgeMs) {
    throw new ReadOnlyTransportError('Stale or future account snapshot');
  }
  return Object.freeze({
    accountId:payload.accountId,environment:'demo',currency:payload.currency,
    balance:payload.balance,asOf:payload.asOf,
  });
}
