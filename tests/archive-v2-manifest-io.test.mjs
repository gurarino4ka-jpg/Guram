import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeImmutableSegment } from '../monitor/archive-v2-segment-io.mjs';
import { publishInitialManifest,readInitialManifest } from '../monitor/archive-v2-manifest-io.mjs';

async function fixture(fn) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-manifest-'));
  try { await fn(dir); } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
const a='{"version":1,"id":"a"}\n';
const b='{"version":1,"id":"b"}\n';

test('v2 publishes initial manifest for verified immutable segments',async()=>{
  await fixture(async dir=>{
    const descriptors=[await writeImmutableSegment(dir,1,a),await writeImmutableSegment(dir,2,b)];
    const manifest=await publishInitialManifest(dir,descriptors);
    assert.deepEqual(await readInitialManifest(dir),manifest);
  });
});

test('v2 never overwrites an already published manifest',async()=>{
  await fixture(async dir=>{
    const descriptors=[await writeImmutableSegment(dir,1,a)];
    await publishInitialManifest(dir,descriptors);
    const before=await fs.readFile(path.join(dir,'manifest.json'),'utf8');
    await assert.rejects(publishInitialManifest(dir,descriptors),e=>e.code==='EEXIST');
    assert.equal(await fs.readFile(path.join(dir,'manifest.json'),'utf8'),before);
  });
});

test('v2 refuses to publish manifest when segment was modified',async()=>{
  await fixture(async dir=>{
    const descriptors=[await writeImmutableSegment(dir,1,a)];
    await fs.writeFile(path.join(dir,'segments',descriptors[0].file),a.replace('"a"','"z"'));
    await assert.rejects(publishInitialManifest(dir,descriptors));
    await assert.rejects(fs.stat(path.join(dir,'manifest.json')),e=>e.code==='ENOENT');
  });
});

test('v2 rejects corrupted manifest framing on read',async()=>{
  await fixture(async dir=>{
    const descriptors=[await writeImmutableSegment(dir,1,a)];
    await publishInitialManifest(dir,descriptors);
    await fs.appendFile(path.join(dir,'manifest.json'),'extra');
    await assert.rejects(readInitialManifest(dir));
  });
});
