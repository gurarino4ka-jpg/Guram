import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeImmutableSegment } from '../monitor/archive-v2-segment-io.mjs';
import { buildVersionedManifest,writeVersionedManifest } from '../monitor/archive-v2-generations.mjs';
import { publishInitialHead,readHead } from '../monitor/archive-v2-head.mjs';
import { acquireV2WriterLock } from '../monitor/archive-v2-writer-lock.mjs';
import { commitPreparedGeneration } from '../monitor/archive-v2-commit.mjs';
import { verifyPublishedChain } from '../monitor/archive-v2-audit.mjs';
import { SegmentManifestError } from '../monitor/archive-v2-manifest.mjs';

async function fixture(fn) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-commit-'));
  try { await fn(dir); } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
async function setup(dir) {
  const a=await writeImmutableSegment(dir,1,'{"id":"a"}\n');
  const first=buildVersionedManifest(1,[a]);
  await writeVersionedManifest(dir,first);
  await publishInitialHead(dir,first);
  const b=await writeImmutableSegment(dir,2,'{"id":"b"}\n');
  const second=buildVersionedManifest(2,[a,b],first.manifestHash);
  await writeVersionedManifest(dir,second);
  return {first,second,b};
}

test('v2 commits prepared generation and audits published chain',async()=>{
  await fixture(async dir=>{
    const {second}=await setup(dir);
    const lock=await acquireV2WriterLock(dir);
    try {
      assert.deepEqual(await commitPreparedGeneration(dir,lock,2),{
        generation:2,manifestHash:second.manifestHash,
      });
      assert.deepEqual(await verifyPublishedChain(dir),{generation:2,segments:2});
    } finally { await lock.release(); }
  });
});

test('v2 rejects duplicate generation commit',async()=>{
  await fixture(async dir=>{
    await setup(dir);
    const lock=await acquireV2WriterLock(dir);
    try {
      await commitPreparedGeneration(dir,lock,2);
      await assert.rejects(commitPreparedGeneration(dir,lock,2),SegmentManifestError);
    } finally { await lock.release(); }
  });
});

test('v2 refuses commit if segment was tampered',async()=>{
  await fixture(async dir=>{
    const {first,b}=await setup(dir);
    await fs.writeFile(path.join(dir,'segments',b.file),'{"id":"z"}\n');
    const lock=await acquireV2WriterLock(dir);
    try {
      await assert.rejects(commitPreparedGeneration(dir,lock,2),SegmentManifestError);
      assert.deepEqual(await readHead(dir),{generation:1,manifestHash:first.manifestHash});
    } finally { await lock.release(); }
  });
});

test('v2 refuses commit after writer lock loss',async()=>{
  await fixture(async dir=>{
    const {first}=await setup(dir);
    const lock=await acquireV2WriterLock(dir);
    await fs.unlink(path.join(dir,'archive.lock'));
    await assert.rejects(commitPreparedGeneration(dir,lock,2),SegmentManifestError);
    assert.deepEqual(await readHead(dir),{generation:1,manifestHash:first.manifestHash});
    await lock.release();
  });
});
