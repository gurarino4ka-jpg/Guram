import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeImmutableSegment } from '../monitor/archive-v2-segment-io.mjs';
import { buildVersionedManifest,writeVersionedManifest,generationFile } from '../monitor/archive-v2-generations.mjs';
import { publishInitialHead,readHead } from '../monitor/archive-v2-head.mjs';
import { acquireV2WriterLock } from '../monitor/archive-v2-writer-lock.mjs';
import { prepareV2Generation } from '../monitor/archive-v2-prepare.mjs';
import { SegmentManifestError } from '../monitor/archive-v2-manifest.mjs';

async function fixture(fn) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-prepare-'));
  try { await fn(dir); } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
async function setup(dir) {
  const firstSegment=await writeImmutableSegment(dir,1,'{"id":"a"}\n');
  const first=buildVersionedManifest(1,[firstSegment]);
  await writeVersionedManifest(dir,first);
  await publishInitialHead(dir,first);
  const secondSegment=await writeImmutableSegment(dir,2,'{"id":"b"}\n');
  const second=buildVersionedManifest(2,[firstSegment,secondSegment],first.manifestHash);
  return {first,second};
}

test('v2 prepares next generation without publishing HEAD',async()=>{
  await fixture(async dir=>{
    const {first,second}=await setup(dir);
    const lock=await acquireV2WriterLock(dir);
    try {
      const next=await prepareV2Generation(dir,lock,second);
      assert.equal(next.generation,2);
      assert.deepEqual(await readHead(dir),{generation:1,manifestHash:first.manifestHash});
      assert.equal((await fs.readFile(path.join(dir,'manifests',generationFile(2)),'utf8')).length>0,true);
    } finally { await lock.release(); }
  });
});

test('v2 refuses preparation without a writer lock',async()=>{
  await fixture(async dir=>{
    const {second}=await setup(dir);
    await assert.rejects(prepareV2Generation(dir,null,second),SegmentManifestError);
    await assert.rejects(fs.stat(path.join(dir,'manifests',generationFile(2))),e=>e.code==='ENOENT');
  });
});

test('v2 refuses preparation after ownership loss',async()=>{
  await fixture(async dir=>{
    const {second}=await setup(dir);
    const lock=await acquireV2WriterLock(dir);
    await fs.unlink(path.join(dir,'archive.lock'));
    await assert.rejects(prepareV2Generation(dir,lock,second),SegmentManifestError);
    await assert.rejects(fs.stat(path.join(dir,'manifests',generationFile(2))),e=>e.code==='ENOENT');
    await lock.release();
  });
});

test('v2 rejects stale next generation without creating file',async()=>{
  await fixture(async dir=>{
    const {first,second}=await setup(dir);
    const stale=buildVersionedManifest(3,second.segments,first.manifestHash);
    const lock=await acquireV2WriterLock(dir);
    try {
      await assert.rejects(prepareV2Generation(dir,lock,stale),SegmentManifestError);
      await assert.rejects(fs.stat(path.join(dir,'manifests',generationFile(3))),e=>e.code==='ENOENT');
    } finally { await lock.release(); }
  });
});
