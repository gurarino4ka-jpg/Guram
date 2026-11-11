import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm,stat,mkdir,utimes } from 'node:fs/promises';
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

test('rejects sequential checkpoint replay, rollback and account switching',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'demo-checkpoint-'));
  try {
    const store=createDemoAccountCheckpointStore({filePath:join(dir,'checkpoint.json')});
    await store.save(checkpoint);
    for(const bad of [checkpoint,{...checkpoint,asOf:'2026-11-11T05:59:29.000Z'},
      {...checkpoint,accountId:'other_demo',asOf:'2026-11-11T05:59:31.000Z'}]) {
      await assert.rejects(store.save(bad),ReadOnlyTransportError);
      assert.deepEqual(await store.load(),checkpoint);
    }
    await store.save({...checkpoint,asOf:'2026-11-11T05:59:31.000Z'});
    assert.equal((await store.load()).asOf,'2026-11-11T05:59:31.000Z');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('cross-instance checkpoint lock rejects concurrent or stale lock holders',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'demo-checkpoint-'));
  try {
    const filePath=join(dir,'checkpoint.json');
    const first=createDemoAccountCheckpointStore({filePath});
    const second=createDemoAccountCheckpointStore({filePath});
    await mkdir(filePath+'.lock');
    await assert.rejects(first.save(checkpoint),ReadOnlyTransportError);
    await assert.rejects(second.save(checkpoint),ReadOnlyTransportError);
    assert.equal(await first.load(),null);
    await rm(filePath+'.lock',{recursive:true});
    await first.save(checkpoint);
    await assert.rejects(second.save(checkpoint),ReadOnlyTransportError);
    await second.save({...checkpoint,asOf:'2026-11-11T05:59:31.000Z'});
    assert.equal((await first.load()).asOf,'2026-11-11T05:59:31.000Z');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('never steals an old checkpoint lock even if its mtime is stale',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'demo-checkpoint-'));
  try {
    const filePath=join(dir,'checkpoint.json');
    const lockPath=filePath+'.lock';
    const store=createDemoAccountCheckpointStore({filePath});
    await mkdir(lockPath);
    const old=new Date('2000-01-01T00:00:00.000Z');
    await utimes(lockPath,old,old);
    await assert.rejects(store.save(checkpoint),ReadOnlyTransportError);
    assert.equal((await stat(lockPath)).isDirectory(),true);
    assert.equal(await store.load(),null);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
