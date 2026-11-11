import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeImmutableSegment } from '../monitor/archive-v2-segment-io.mjs';
import { buildVersionedManifest,writeVersionedManifest,generationFile } from '../monitor/archive-v2-generations.mjs';
import { publishInitialHead } from '../monitor/archive-v2-head.mjs';
import { verifyPublishedChain } from '../monitor/archive-v2-audit.mjs';
import { SegmentManifestError } from '../monitor/archive-v2-manifest.mjs';

async function fixture(fn) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-audit-'));
  try { await fn(dir); } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
async function setup(dir) {
  const descriptor=await writeImmutableSegment(dir,1,'{"id":"a"}\n');
  const first=buildVersionedManifest(1,[descriptor]);
  await writeVersionedManifest(dir,first);
  await publishInitialHead(dir,first);
  return {descriptor,first};
}

test('v2 audits committed generation and segment contents',async()=>{
  await fixture(async dir=>{
    await setup(dir);
    assert.deepEqual(await verifyPublishedChain(dir),{generation:1,segments:1});
  });
});

test('v2 audit detects same-length sealed segment tampering',async()=>{
  await fixture(async dir=>{
    const {descriptor}=await setup(dir);
    await fs.writeFile(path.join(dir,'segments',descriptor.file),'{"id":"z"}\n');
    await assert.rejects(verifyPublishedChain(dir),SegmentManifestError);
  });
});

test('v2 audit rejects unexpected manifest generations',async()=>{
  await fixture(async dir=>{
    await setup(dir);
    await fs.writeFile(path.join(dir,'manifests',generationFile(2)),'{}\n');
    await assert.rejects(verifyPublishedChain(dir),SegmentManifestError);
  });
});

test('v2 audit rejects unexpected sealed segments',async()=>{
  await fixture(async dir=>{
    await setup(dir);
    await fs.writeFile(path.join(dir,'segments','000000000002.jsonl'),'{}\n');
    await assert.rejects(verifyPublishedChain(dir),SegmentManifestError);
  });
});
