import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCandleArchive, ArchiveStoreError } from '../monitor/archive-store.mjs';

test('SIGKILL after durable append preserves journal and requires manual stale-lock recovery',{
  skip:process.platform==='win32'?'SIGKILL semantics differ on Windows':false,
  timeout:20000,
},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca-crash-'));
  const child=fork(fileURLToPath(new URL('./archive-crash-child.mjs',import.meta.url)),[dir],{
    stdio:['ignore','pipe','pipe','ipc'],
  });
  try {
    await Promise.race([
      new Promise((resolve,reject)=>{
        child.once('message',message=>message?.ready?resolve():reject(new Error('Invalid child response')));
        child.once('error',reject);
        child.once('exit',(code,signal)=>reject(new Error('Child exited before ready: '+code+'/'+signal)));
      }),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('Child startup timeout')),10000)),
    ]);
    child.kill('SIGKILL');
    await new Promise(resolve=>child.once('exit',resolve));
    const archive=await createCandleArchive(dir);
    await assert.rejects(archive.open(),e=>e instanceof ArchiveStoreError&&e.code==='locked');
    const journal=path.join(dir,'archive','v1','observations.jsonl');
    const before=await fs.readFile(journal);
    // This is a fixture-only recovery. Production requires operator verification
    // that the prior owner is dead before removing a stale lock.
    await fs.unlink(path.join(dir,'archive','v1','archive.lock'));
    await archive.open();
    const market={
      schemaVersion:1,provider:'synthetic',providerSymbol:'CRASH',providerTicker:null,
      displayName:null,exchange:null,marketType:'unknown',priceBasis:'unknown',
      quoteAsset:null,settlementToken:null,resolution:'60',
    };
    assert.equal(archive.getRevisions(market,3_600_000).length,1);
    await archive.close();
    assert.deepEqual(await fs.readFile(journal),before);
  } finally {
    if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
    await fs.rm(dir,{recursive:true,force:true});
  }
});
