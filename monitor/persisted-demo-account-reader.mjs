import { createDemoAccountReader } from './demo-account-reader.mjs';
import { ReadOnlyTransportError } from './readonly-transport.mjs';

// Fail closed: do not expose an account snapshot until its checkpoint is durable.
// No provider endpoint, credentials, or trading operations are configured here.
export async function createPersistedDemoAccountReader({store,...readerOptions}={}) {
  if(!store||typeof store.load!=='function'||typeof store.save!=='function') {
    throw new ReadOnlyTransportError('Checkpoint store required');
  }
  let checkpoint;
  try { checkpoint=await store.load(); }
  catch { throw new ReadOnlyTransportError('Checkpoint restore failed'); }
  const read=createDemoAccountReader({...readerOptions,checkpoint});
  let busy=false;
  return async function readPersistedDemoAccount({signal}={}) {
    if(busy) throw new ReadOnlyTransportError('Concurrent persisted read forbidden');
    busy=true;
    try {
      const snapshot=await read({signal});
      try { await store.save(read.getCheckpoint()); }
      catch { throw new ReadOnlyTransportError('Checkpoint persistence failed'); }
      return snapshot;
    } finally { busy=false; }
  };
}
