import fs from 'node:fs/promises';
import path from 'node:path';
import { SegmentManifestError, verifySegmentManifest } from './archive-v2-manifest.mjs';
import { readVersionedManifest,generationFile } from './archive-v2-generations.mjs';
import { readHead } from './archive-v2-head.mjs';

// Offline verification only: requires a quiescent archive and a trusted root.
// It does not establish a transactional snapshot against an external writer.
export async function verifyPublishedChain(root) {
  if(typeof root!=='string'||!root.trim()) throw new SegmentManifestError('Invalid root');
  const base=path.resolve(root);
  const head=await readHead(base);
  const names=await fs.readdir(path.join(base,'manifests'));
  // Reject implausible HEAD before allocating a generation-sized array.
  if(names.length!==head.generation) {
    throw new SegmentManifestError('Missing or unexpected manifest generation');
  }
  const expected=Array.from({length:names.length},(_,i)=>generationFile(i+1));
  if(names.slice().sort().some((name,i)=>name!==expected[i])) {
    throw new SegmentManifestError('Missing or unexpected manifest generation');
  }
  let previousHash=null;
  let previousSegments=[];
  let latest;
  for(let generation=1;generation<=head.generation;generation++) {
    const manifest=await readVersionedManifest(base,generation);
    if(manifest.previousHash!==previousHash) throw new SegmentManifestError('Broken manifest chain');
    if(manifest.segments.length<previousSegments.length) throw new SegmentManifestError('Segment history shrank');
    for(let i=0;i<previousSegments.length;i++) {
      if(JSON.stringify(manifest.segments[i])!==JSON.stringify(previousSegments[i])) {
        throw new SegmentManifestError('Sealed segment descriptor changed');
      }
    }
    previousHash=manifest.manifestHash;
    previousSegments=manifest.segments;
    latest=manifest;
  }
  if(latest.manifestHash!==head.manifestHash) throw new SegmentManifestError('HEAD chain mismatch');
  const segmentDir=path.join(base,'segments');
  const namesOnDisk=await fs.readdir(segmentDir);
  const segmentNames=latest.segments.map(s=>s.file);
  if(namesOnDisk.length!==segmentNames.length||
      namesOnDisk.slice().sort().some((name,i)=>name!==segmentNames[i])) {
    throw new SegmentManifestError('Missing or unexpected sealed segment');
  }
  const contents=Object.create(null);
  for(const descriptor of latest.segments) {
    const file=path.join(segmentDir,descriptor.file);
    const before=await fs.lstat(file);
    if(!before.isFile()||before.isSymbolicLink()) throw new SegmentManifestError('Invalid segment file');
    const handle=await fs.open(file,'r');
    try {
      const opened=await handle.stat();
      if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino) {
        throw new SegmentManifestError('Segment replaced before read');
      }
      contents[descriptor.file]=await handle.readFile('utf8');
      const after=await fs.lstat(file);
      if(!after.isFile()||after.isSymbolicLink()||
          after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size) {
        throw new SegmentManifestError('Segment changed during read');
      }
    } finally { await handle.close(); }
  }
  verifySegmentManifest({
    version:2,segments:latest.segments,checksum:latest.segmentChecksum,
  },contents);
  return {generation:head.generation,segments:latest.segments.length};
}
