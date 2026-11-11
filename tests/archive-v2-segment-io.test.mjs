import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeImmutableSegment } from '../monitor/archive-v2-segment-io.mjs';
import { createSegmentManifest, verifySegmentManifest, segmentName } from '../monitor/archive-v2-manifest.mjs';

async function fixture(fn) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-io-'));
  try { await fn(dir); } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
const content='{"version":1,"id":"a"}\n';

test('v2 immutable segment is persisted and verifiable',async()=>{
  await fixture(async dir=>{
    const descriptor=await writeImmutableSegment(dir,1,content);
    const saved=await fs.readFile(path.join(dir,'segments',segmentName(1)),'utf8');
    assert.equal(saved,content);
    assert.equal(verifySegmentManifest(createSegmentManifest([descriptor]),{[descriptor.file]:saved}),true);
  });
});

test('v2 immutable segment never overwrites an existing file',async()=>{
  await fixture(async dir=>{
    await writeImmutableSegment(dir,1,content);
    const replacement='{"version":1,"id":"b"}\n';
    await assert.rejects(writeImmutableSegment(dir,1,replacement),e=>e.code==='EEXIST');
    assert.equal(await fs.readFile(path.join(dir,'segments',segmentName(1)),'utf8'),content);
  });
});

test('v2 immutable segment refuses an existing symlink target',async()=>{
  await fixture(async dir=>{
    const target=path.join(dir,'outside');
    await fs.writeFile(target,'untouched');
    await fs.mkdir(path.join(dir,'segments'));
    try { await fs.symlink(target,path.join(dir,'segments',segmentName(1))); }
    catch(e) { if(e.code==='EPERM'||e.code==='EACCES') return; throw e; }
    await assert.rejects(writeImmutableSegment(dir,1,content),e=>e.code==='EEXIST');
    assert.equal(await fs.readFile(target,'utf8'),'untouched');
  });
});

test('v2 immutable segment refuses symlinked segments directory',async()=>{
  await fixture(async dir=>{
    const outside=path.join(dir,'outside');
    await fs.mkdir(outside);
    try { await fs.symlink(outside,path.join(dir,'segments'),'dir'); }
    catch(e) { if(e.code==='EPERM'||e.code==='EACCES') return; throw e; }
    await assert.rejects(writeImmutableSegment(dir,1,content));
    assert.deepEqual(await fs.readdir(outside),[]);
  });
});
