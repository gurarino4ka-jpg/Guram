import { readFile,rename,unlink,open,mkdir,rmdir,lstat } from 'node:fs/promises';
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
  // Never expire or steal this lock by age: a paused process may still own it.
  // After a crash, an operator must verify all writers stopped before removing it.
  const lockPath=target+'.lock';
  async function rejectUnsafeTarget() {
    try {
      const info=await lstat(target);
      if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1) throw new ReadOnlyTransportError('Unsafe checkpoint file');
    } catch(error) {
      if(error?.code==='ENOENT') return;
      throw new ReadOnlyTransportError('Unsafe checkpoint file');
    }
  }
  let saving=false;
  const store={
    async load() {
      await rejectUnsafeTarget();
      let content;
      let handle;
      try {
        handle=await open(target,'r');
        const info=await handle.stat();
        if(!info.isFile()||info.nlink!==1||info.size>4096) throw new Error('Unsafe checkpoint size');
        const buffer=Buffer.alloc(4097);
        let used=0;
        while(used<buffer.length) {
          const {bytesRead}=await handle.read(buffer,used,buffer.length-used,used);
          if(bytesRead===0) break;
          used+=bytesRead;
        }
        if(used>4096) throw new Error('Checkpoint too large');
        content=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used));
      } catch(error) {
        if(error?.code==='ENOENT') return null;
        throw new ReadOnlyTransportError('Checkpoint read failed');
      } finally {
        if(handle) await handle.close();
      }
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
      await rejectUnsafeTarget();
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
        await rejectUnsafeTarget();
        await rename(temp,target);
        // POSIX: fsync the parent directory so the rename survives a crash.
        // Windows does not expose a portable directory fsync via Node.
        if(process.platform!=='win32') {
          const dirHandle=await open(dirname(target),'r');
          try { await dirHandle.sync(); }
          finally { await dirHandle.close(); }
        }
      } catch {
        if(handle) { try { await handle.close(); } catch {} }
        try { await unlink(temp); } catch {}
        throw new ReadOnlyTransportError('Checkpoint write failed');
      }
      } finally {
        saving=false;
        if(locked) { try { await rmdir(lockPath); } catch { throw new ReadOnlyTransportError('Checkpoint lock cleanup failed'); } }
      }
    },
  };
  return Object.freeze(store);
}
