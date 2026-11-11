import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireV2WriterLock } from '../monitor/archive-v2-writer-lock.mjs';
import { SegmentManifestError } from '../monitor/archive-v2-manifest.mjs';

async function fixture(fn) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-lock-'));
  try { await fn(dir); } finally { await fs.rm(dir,{recursive:true,force:true}); }
}

test('v2 writer lock allows one writer and releases cleanly',async()=>{
  await fixture(async dir=>{
    const first=await acquireV2WriterLock(dir);
    assert.equal(await first.assertOwned(),true);
    await assert.rejects(acquireV2WriterLock(dir),e=>e.code==='EEXIST');
    await first.release();
    const second=await acquireV2WriterLock(dir);
    await second.release();
  });
});

test('v2 writer lock rejects missing lock and preserves successor',async()=>{
  await fixture(async dir=>{
    const first=await acquireV2WriterLock(dir);
    await fs.unlink(path.join(dir,'archive.lock'));
    await assert.rejects(first.assertOwned(),SegmentManifestError);
    const second=await acquireV2WriterLock(dir);
    await first.release();
    assert.equal(await second.assertOwned(),true);
    await second.release();
  });
});

test('v2 writer lock rejects in-place token mutation',async()=>{
  await fixture(async dir=>{
    const first=await acquireV2WriterLock(dir);
    const file=path.join(dir,'archive.lock');
    const original=await fs.readFile(file,'utf8');
    await fs.writeFile(file,'x'.repeat(original.length-1)+'\n');
    await assert.rejects(first.assertOwned(),SegmentManifestError);
    await first.release();
    assert.equal(await fs.readFile(file,'utf8'),'x'.repeat(original.length-1)+'\n');
  });
});

test('v2 writer lock refuses symlinked archive root',async()=>{
  await fixture(async dir=>{
    const target=path.join(dir,'real');
    await fs.mkdir(target);
    const alias=path.join(dir,'alias');
    try { await fs.symlink(target,alias,'dir'); }
    catch(e) { if(e.code==='EPERM'||e.code==='EACCES') return; throw e; }
    await assert.rejects(acquireV2WriterLock(alias),SegmentManifestError);
  });
});
