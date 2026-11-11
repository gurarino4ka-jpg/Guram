import { readFile,rename,unlink,open,mkdir,rmdir } from 'node:fs/promises';
import { dirname,basename,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReadOnlyTransportError } from './readonly-transport.mjs';

// Local-only, provider-neutral checkpoint persistence. Caller owns file access
// and must never store credentials in this checkpoint.
function validateCheckpoint(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).sort().join(',')!=='accountId,asOf'||
    typeof value.accountId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(value.accountId)||
    typeof value.asOf!=='string'||!Number.isFinite(Date.parse(value.asOf))||
    new Date(Date.parse(value.asOf)).toISOString()!==value.asOf) {
    throw new ReadOnlyTransportError('Invalid account checkpoint');
  }
  return Object.freeze({accountId:value.accountId,asOf:value.asOf});
}
export function createDemoAccountCheckpointStore({filePath}={}) {
  if(typeof filePath!=='string'||!filePath.trim()||filePath.includes('\0')) {
    throw new ReadOnlyTransportError('Invalid checkpoint file path');
  }
  const target=resolve(filePath);
  const lockPath=target+'.lock';
  let saving=false;
  const store={
    async load() {
      let content;
      try { content=await readFile(target,{encoding:'utf8',flag:'r'}); }
      catch(error) {
        if(error?.code==='ENOENT') return null;
        throw new ReadOnlyTransportError('Checkpoint read failed');
      }
      if(Buffer.byteLength(content,'utf8')>4096) throw new ReadOnlyTransportError('Checkpoint too large');
      try { return validateCheckpoint(JSON.parse(content)); }
      catch { throw new ReadOnlyTransportError('Invalid checkpoint file'); }
    },
    async save(value) {
      if(saving) throw new ReadOnlyTransportError('Concurrent checkpoint save forbidden');
      saving=true;
      let locked=false;
      try {
      const checkpoint=validateCheckpoint(value);
      try { await mkdir(lockPath,{mode:0o700}); locked=true; }
      catch { throw new ReadOnlyTransportError('Checkpoint lock unavailable'); }
      const previous=await store.load();
      if(previous&&(previous.accountId!==checkpoint.accountId||Date.parse(checkpoint.asOf)<=Date.parse(previous.asOf))) {
        throw new ReadOnlyTransportError('Checkpoint regression forbidden');
      }
      const temp=resolve(dirname(target),'.'+basename(target)+'.'+randomUUID()+'.tmp');
      let handle;
      try {
        handle=await open(temp,'wx',0o600);
        await handle.writeFile(JSON.stringify(checkpoint)+'\n','utf8');
        await handle.sync();
        await handle.close();
        handle=null;
        await rename(temp,target);
      } catch {
        if(handle) { try { await handle.close(); } catch {} }
        try { await unlink(temp); } catch {}
        throw new ReadOnlyTransportError('Checkpoint write failed');
      }
      } finally {
        if(locked) { try { await rmdir(lockPath); } catch { throw new ReadOnlyTransportError('Checkpoint lock cleanup failed'); } }
        saving=false;
      }
    },
  };
  return Object.freeze(store);
}
