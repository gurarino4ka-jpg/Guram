import test from 'node:test';
import assert from 'node:assert/strict';
import { createSegmentDescriptor,SegmentManifestError } from '../monitor/archive-v2-manifest.mjs';
import { buildVersionedManifest } from '../monitor/archive-v2-generations.mjs';
import { validateHeadTransition } from '../monitor/archive-v2-transition.mjs';

const a=createSegmentDescriptor(1,'{"id":"a"}\n');
const b=createSegmentDescriptor(2,'{"id":"b"}\n');
const first=buildVersionedManifest(1,[a]);
const current={generation:1,manifestHash:first.manifestHash};
const second=buildVersionedManifest(2,[a,b],first.manifestHash);

test('v2 transition accepts consecutive append-only generation',()=>{
  assert.deepEqual(validateHeadTransition(current,second,first),{
    generation:2,manifestHash:second.manifestHash,
  });
});

test('v2 transition rejects stale HEAD',()=>{
  assert.throws(()=>validateHeadTransition({
    generation:1,manifestHash:'0'.repeat(64),
  },second,first),SegmentManifestError);
});

test('v2 transition rejects skipped generation and broken parent link',()=>{
  const skipped=buildVersionedManifest(3,[a,b],first.manifestHash);
  assert.throws(()=>validateHeadTransition(current,skipped,first),SegmentManifestError);
  const broken=buildVersionedManifest(2,[a,b],'0'.repeat(64));
  assert.throws(()=>validateHeadTransition(current,broken,first),SegmentManifestError);
});

test('v2 transition rejects modifications to sealed history',()=>{
  const changed=createSegmentDescriptor(1,'{"id":"z"}\n');
  const rewritten=buildVersionedManifest(2,[changed,b],first.manifestHash);
  assert.throws(()=>validateHeadTransition(current,rewritten,first),SegmentManifestError);
});

test('v2 transition rejects publication without a new segment',()=>{
  const unchanged=buildVersionedManifest(2,[a],first.manifestHash);
  assert.throws(()=>validateHeadTransition(current,unchanged,first),SegmentManifestError);
});
