import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSegmentDescriptor,SegmentManifestError } from '../monitor/archive-v2-manifest.mjs';
import {
  buildVersionedManifest,verifyVersionedManifest,writeVersionedManifest,
  readVersionedManifest,generationFile,
} from '../monitor/archive-v2-generations.mjs';

const descriptor=createSegmentDescriptor(1,'{"id":"a"}\n');
async function fixture(fn) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-generation-'));
  try { await fn(dir); } finally { await fs.rm(dir,{recursive:true,force:true}); }
}

test('v2 generation 1 is immutable and can be read back',async()=>{
  await fixture(async dir=>{
    const first=buildVersionedManifest(1,[descriptor]);
    assert.equal(verifyVersionedManifest(first),true);
    await writeVersionedManifest(dir,first);
    assert.deepEqual(await readVersionedManifest(dir,1),first);
    await assert.rejects(writeVersionedManifest(dir,first),e=>e.code==='EEXIST');
  });
});

test('v2 generation 2 links previous manifest hash',async()=>{
  await fixture(async dir=>{
    const first=buildVersionedManifest(1,[descriptor]);
    const second=buildVersionedManifest(2,[descriptor],first.manifestHash);
    await writeVersionedManifest(dir,first);
    await writeVersionedManifest(dir,second);
    assert.equal((await readVersionedManifest(dir,2)).previousHash,first.manifestHash);
    assert.equal(generationFile(2),'000000000002.json');
  });
});

test('v2 generation rejects tampered manifest and invalid previous hash',async()=>{
  const first=buildVersionedManifest(1,[descriptor]);
  assert.throws(()=>verifyVersionedManifest({...first,previousHash:'f'.repeat(64)}),SegmentManifestError);
  assert.throws(()=>buildVersionedManifest(2,[descriptor]),SegmentManifestError);
  await fixture(async dir=>{
    await writeVersionedManifest(dir,first);
    const file=path.join(dir,'manifests',generationFile(1));
    await fs.writeFile(file,JSON.stringify({...first,manifestHash:'0'.repeat(64)})+'\n');
    await assert.rejects(readVersionedManifest(dir,1),SegmentManifestError);
  });
});

test('v2 generation rejects symlinked manifest directory',async()=>{
  await fixture(async dir=>{
    const target=path.join(dir,'other');
    await fs.mkdir(target);
    try { await fs.symlink(target,path.join(dir,'manifests'),'dir'); }
    catch(e) { if(e.code==='EPERM'||e.code==='EACCES') return; throw e; }
    await assert.rejects(writeVersionedManifest(dir,buildVersionedManifest(1,[descriptor])));
    assert.deepEqual(await fs.readdir(target),[]);
  });
});
