import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoAccountCheckpointStore } from '../monitor/demo-account-checkpoint-store.mjs';
import { ReadOnlyTransportError } from '../monitor/readonly-transport.mjs';

const checkpoint={accountId:'demo_123',asOf:'2026-11-11T05:59:30.000Z'};
test('checkpoint store atomically saves and restores canonical data',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'demo-checkpoint-'));
  try {
    const filePath=join(dir,'checkpoint.json');
    const store=createDemoAccountCheckpointStore({filePath});
    assert.equal(await store.load(),null);
    await store.save(checkpoint);
    assert.deepEqual(await store.load(),checkpoint);
    assert.deepEqual(JSON.parse(await readFile(filePath,'utf8')),checkpoint);
    if(process.platform!=='win32') assert.equal((await stat(filePath)).mode&0o777,0o600);
    await store.save({...checkpoint,asOf:'2026-11-11T05:59:31.000Z'});
    assert.equal((await store.load()).asOf,'2026-11-11T05:59:31.000Z');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('checkpoint store rejects malformed, oversized and invalid checkpoint files',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'demo-checkpoint-'));
  try {
    const filePath=join(dir,'checkpoint.json');
    const store=createDemoAccountCheckpointStore({filePath});
    for(const bad of ['not json','{}','{"accountId":"demo_123","asOf":"invalid"}',' '.repeat(4097)]) {
      await writeFile(filePath,bad);
      await assert.rejects(store.load(),ReadOnlyTransportError);
    }
    await assert.rejects(store.save({...checkpoint,secret:'token'}),ReadOnlyTransportError);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
