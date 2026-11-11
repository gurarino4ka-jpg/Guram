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
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-recovery-orphan-'));
  try { await fn(root); } finally { await fs.rm(root,{recursive:true,force:true}); }
}
async function setup(root) {
  const descriptor=await writeImmutableSegment(root,1,'{"id":"a"}\n');
  const manifest=buildVersionedManifest(1,[descriptor]);
  await writeVersionedManifest(root,manifest);
  await publishInitialHead(root,manifest);
  return descriptor;
}
test('recovery marks orphan segments and never deletes them',async()=>{
  await fixture(async root=>{
    await setup(root);
    const orphan=await writeImmutableSegment(root,2,'{"id":"b"}\n');
    const result=await inspectV2Recovery(root);
    assert.deepEqual(result.orphanSegments,[orphan.file]);
    assert.equal(result.committedIntegrityVerified,false);
    assert.equal(result.requiresOperatorReview,true);
    assert.equal((await fs.readFile(path.join(root,'segments',orphan.file),'utf8')),'{"id":"b"}\n');
  });
});
test('recovery distinguishes verified committed archive',async()=>{
  await fixture(async root=>{
    await setup(root);
    const result=await inspectV2Recovery(root);
    assert.deepEqual(result.orphanSegments,[]);
    assert.equal(result.committedIntegrityVerified,true);
    assert.equal(result.requiresOperatorReview,false);
  });
});
test('recovery flags corrupted committed segment without changing it',async()=>{
  await fixture(async root=>{
    const descriptor=await setup(root);
    const file=path.join(root,'segments',descriptor.file);
    await fs.writeFile(file,'{"id":"z"}\n');
    const result=await inspectV2Recovery(root);
    assert.equal(result.committedIntegrityVerified,false);
    assert.equal(result.requiresOperatorReview,true);
    assert.equal(await fs.readFile(file,'utf8'),'{"id":"z"}\n');
  });
});
