import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeImmutableSegment } from '../monitor/archive-v2-segment-io.mjs';
import { buildVersionedManifest,writeVersionedManifest } from '../monitor/archive-v2-generations.mjs';
import { verifyPublishedChain } from '../monitor/archive-v2-audit.mjs';
import { inspectV2Recovery } from '../monitor/archive-v2-recovery.mjs';
import { SegmentManifestError } from '../monitor/archive-v2-manifest.mjs';

test('huge valid HEAD generation fails bounded audit without allocating a trillion entries',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-huge-head-'));
  try {
    const descriptor=await writeImmutableSegment(root,1,'{"id":"a"}\n');
    const generation=999999999999;
    const manifest=buildVersionedManifest(generation,[descriptor],'a'.repeat(64));
    await writeVersionedManifest(root,manifest);
    await fs.writeFile(path.join(root,'HEAD'),JSON.stringify({
      generation,manifestHash:manifest.manifestHash,
    })+'\n');
    await assert.rejects(verifyPublishedChain(root),SegmentManifestError);
    const inspection=await inspectV2Recovery(root);
    assert.equal(inspection.committedIntegrityVerified,false);
    assert.equal(inspection.requiresOperatorReview,true);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
