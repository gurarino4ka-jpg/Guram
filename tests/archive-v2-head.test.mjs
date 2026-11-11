import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSegmentDescriptor,SegmentManifestError } from '../monitor/archive-v2-manifest.mjs';
import { buildVersionedManifest,writeVersionedManifest } from '../monitor/archive-v2-generations.mjs';
import { publishInitialHead,readHead } from '../monitor/archive-v2-head.mjs';

async function fixture(fn) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-head-'));
  try { await fn(dir); } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
const setup=async dir=>{
  const descriptor=createSegmentDescriptor(1,'{"id":"a"}\n');
  const manifest=buildVersionedManifest(1,[descriptor]);
  await writeVersionedManifest(dir,manifest);
  return manifest;
};

test('initial HEAD points to a verified generation manifest',async()=>{
  await fixture(async dir=>{
    const manifest=await setup(dir);
    const head=await publishInitialHead(dir,manifest);
    assert.deepEqual(await readHead(dir),head);
  });
});

test('initial HEAD is never overwritten by a second initializer',async()=>{
  await fixture(async dir=>{
    const manifest=await setup(dir);
    await publishInitialHead(dir,manifest);
    const original=await fs.readFile(path.join(dir,'HEAD'),'utf8');
    await assert.rejects(publishInitialHead(dir,manifest),e=>e.code==='EEXIST');
    assert.equal(await fs.readFile(path.join(dir,'HEAD'),'utf8'),original);
  });
});

test('HEAD detects tampered generation hash',async()=>{
  await fixture(async dir=>{
    const manifest=await setup(dir);
    await publishInitialHead(dir,manifest);
    await fs.writeFile(path.join(dir,'HEAD'),JSON.stringify({
      generation:1,manifestHash:'0'.repeat(64),
    })+'\n');
    await assert.rejects(readHead(dir),SegmentManifestError);
  });
});

test('HEAD rejects a symlink target and preserves its referent',async()=>{
  await fixture(async dir=>{
    const manifest=await setup(dir);
    const referent=path.join(dir,'outside');
    await fs.writeFile(referent,'keep');
    try { await fs.symlink(referent,path.join(dir,'HEAD')); }
    catch(e) { if(e.code==='EPERM'||e.code==='EACCES') return; throw e; }
    await assert.rejects(publishInitialHead(dir,manifest),e=>e.code==='EEXIST');
    await assert.rejects(readHead(dir),SegmentManifestError);
    assert.equal(await fs.readFile(referent,'utf8'),'keep');
  });
});
