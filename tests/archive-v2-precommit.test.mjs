import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeImmutableSegment } from '../monitor/archive-v2-segment-io.mjs';
import { buildVersionedManifest,writeVersionedManifest } from '../monitor/archive-v2-generations.mjs';
import { verifyPreparedGeneration } from '../monitor/archive-v2-precommit.mjs';
import { SegmentManifestError } from '../monitor/archive-v2-manifest.mjs';

async function fixture(fn) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-precommit-'));
  try { await fn(dir); } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
async function setup(dir) {
  const a=await writeImmutableSegment(dir,1,'{"id":"a"}\n');
  const b=await writeImmutableSegment(dir,2,'{"id":"b"}\n');
  const first=buildVersionedManifest(1,[a]);
  const second=buildVersionedManifest(2,[a,b],first.manifestHash);
  await writeVersionedManifest(dir,first);
  await writeVersionedManifest(dir,second);
  return {a,b,second};
}

test('v2 precommit verifies all prepared sealed segments',async()=>{
  await fixture(async dir=>{
    const {second}=await setup(dir);
    assert.deepEqual(await verifyPreparedGeneration(dir,2),{
      generation:2,manifestHash:second.manifestHash,segments:2,
    });
  });
});

test('v2 precommit rejects same-length segment tampering',async()=>{
  await fixture(async dir=>{
    const {b}=await setup(dir);
    await fs.writeFile(path.join(dir,'segments',b.file),'{"id":"z"}\n');
    await assert.rejects(verifyPreparedGeneration(dir,2),SegmentManifestError);
  });
});

test('v2 precommit rejects missing and extra sealed segments',async()=>{
  await fixture(async dir=>{
    const {b}=await setup(dir);
    await fs.unlink(path.join(dir,'segments',b.file));
    await assert.rejects(verifyPreparedGeneration(dir,2),SegmentManifestError);
  });
  await fixture(async dir=>{
    await setup(dir);
    await fs.writeFile(path.join(dir,'segments','000000000003.jsonl'),'{}\n');
    await assert.rejects(verifyPreparedGeneration(dir,2),SegmentManifestError);
  });
});

test('v2 precommit rejects symlinked segment',async()=>{
  await fixture(async dir=>{
    const {b}=await setup(dir);
    const target=path.join(dir,'other');
    await fs.writeFile(target,'{"id":"b"}\n');
    await fs.unlink(path.join(dir,'segments',b.file));
    try { await fs.symlink(target,path.join(dir,'segments',b.file)); }
    catch(e) { if(e.code==='EPERM'||e.code==='EACCES') return; throw e; }
    await assert.rejects(verifyPreparedGeneration(dir,2),SegmentManifestError);
  });
});
