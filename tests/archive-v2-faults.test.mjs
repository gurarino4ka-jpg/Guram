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
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-fault-'));
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
  return {first,second};
}

for(const faultAt of ['after-stage-sync','before-rename','after-rename','after-directory-sync']) {
  test('v2 fault injection '+faultAt,async()=>{
    await fixture(async dir=>{
      const {first,second}=await setup(dir);
      const lock=await acquireV2WriterLock(dir);
      try {
        await assert.rejects(commitPreparedGeneration(dir,lock,2,{faultAt}),SegmentManifestError);
        const head=await readHead(dir);
        if(faultAt==='after-stage-sync'||faultAt==='before-rename') {
          assert.deepEqual(head,{generation:1,manifestHash:first.manifestHash});
        } else {
          assert.deepEqual(head,{generation:2,manifestHash:second.manifestHash});
        }
        // Unpublished generation 2 is an orphan; fail closed until resolved.
        if(head.generation===1) {
          await assert.rejects(verifyPublishedChain(dir),SegmentManifestError);
        } else {
          assert.deepEqual(await verifyPublishedChain(dir),{generation:2,segments:2});
        }
      } finally { await lock.release(); }
    });
  });
}
