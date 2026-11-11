import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SegmentManifestError,segmentName,createSegmentDescriptor,
  createSegmentManifest,verifySegmentManifest,
} from '../monitor/archive-v2-manifest.mjs';

const a='{"version":1,"id":"a"}\n';
const b='{"version":1,"id":"b"}\n{"version":1,"id":"c"}\n';
const build=()=>{
  const descriptors=[createSegmentDescriptor(1,a),createSegmentDescriptor(2,b)];
  return {manifest:createSegmentManifest(descriptors),contents:{
    [segmentName(1)]:a,[segmentName(2)]:b,
  }};
};

test('v2 prototype verifies two immutable segments',()=>{
  const {manifest,contents}=build();
  assert.equal(verifySegmentManifest(manifest,contents),true);
  assert.equal(manifest.segments[1].batches,2);
});

test('v2 prototype detects same-length segment tampering',()=>{
  const {manifest,contents}=build();
  contents[segmentName(1)]=a.replace('"a"','"z"');
  assert.throws(()=>verifySegmentManifest(manifest,contents),SegmentManifestError);
});

test('v2 prototype rejects missing and unexpected segments',()=>{
  const {manifest,contents}=build();
  delete contents[segmentName(1)];
  assert.throws(()=>verifySegmentManifest(manifest,contents),SegmentManifestError);
  const extra=build();
  extra.contents['000000000003.jsonl']='{}\n';
  assert.throws(()=>verifySegmentManifest(extra.manifest,extra.contents),SegmentManifestError);
});

test('v2 prototype rejects reordered, duplicate and nonconsecutive descriptors',()=>{
  const {manifest}=build();
  assert.throws(()=>createSegmentManifest([...manifest.segments].reverse()),SegmentManifestError);
  assert.throws(()=>createSegmentManifest([manifest.segments[0],manifest.segments[0]]),SegmentManifestError);
  assert.throws(()=>createSegmentManifest([manifest.segments[1]]),SegmentManifestError);
});

test('v2 prototype rejects forged manifest checksum and invalid JSONL',()=>{
  const {manifest,contents}=build();
  assert.throws(()=>verifySegmentManifest({...manifest,checksum:'0'.repeat(64)},contents),SegmentManifestError);
  assert.throws(()=>createSegmentDescriptor(1,'{"bad":\n'),SegmentManifestError);
  assert.throws(()=>createSegmentDescriptor(1,'{}'),SegmentManifestError);
});
