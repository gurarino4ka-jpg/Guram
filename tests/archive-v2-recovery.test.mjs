import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeImmutableSegment } from '../monitor/archive-v2-segment-io.mjs';
import { buildVersionedManifest,writeVersionedManifest } from '../monitor/archive-v2-generations.mjs';
import { publishInitialHead } from '../monitor/archive-v2-head.mjs';
import { inspectV2Recovery } from '../monitor/archive-v2-recovery.mjs';

async function fixture(fn) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-recovery-'));
  try { await fn(dir); } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
async function setup(dir) {
  const descriptor=await writeImmutableSegment(dir,1,'{"id":"a"}\n');
  const first=buildVersionedManifest(1,[descriptor]);
  await writeVersionedManifest(dir,first);
  await publishInitialHead(dir,first);
  return first;
}

test('v2 recovery inspection reports clean archive without mutations',async()=>{
  await fixture(async dir=>{
    const first=await setup(dir);
    const result=await inspectV2Recovery(dir);
    assert.deepEqual(result.head,{generation:1,manifestHash:first.manifestHash});
    assert.deepEqual(result.orphanManifests,[]);
    assert.deepEqual(result.stagingFiles,[]);
    assert.equal(result.requiresOperatorReview,false);
  });
});

test('v2 recovery inspection preserves unpublished manifest',async()=>{
  await fixture(async dir=>{
    const first=await setup(dir);
    const next=buildVersionedManifest(2,first.segments,first.manifestHash);
    await writeVersionedManifest(dir,next);
    const result=await inspectV2Recovery(dir);
    assert.deepEqual(result.orphanManifests,['000000000002.json']);
    assert.equal(result.requiresOperatorReview,true);
    assert.equal((await fs.readdir(path.join(dir,'manifests'))).length,2);
  });
});

test('v2 recovery inspection preserves interrupted staging file',async()=>{
  await fixture(async dir=>{
    await setup(dir);
    const staged=path.join(dir,'.HEAD-incident.tmp');
    await fs.writeFile(staged,'partial');
    const result=await inspectV2Recovery(dir);
    assert.deepEqual(result.stagingFiles,['.HEAD-incident.tmp']);
    assert.equal(result.requiresOperatorReview,true);
    assert.equal(await fs.readFile(staged,'utf8'),'partial');
  });
});

test('v2 recovery inspection fails closed when HEAD is corrupt',async()=>{
  await fixture(async dir=>{
    await setup(dir);
    await fs.writeFile(path.join(dir,'HEAD'),'bad\n');
    await assert.rejects(inspectV2Recovery(dir));
  });
});
