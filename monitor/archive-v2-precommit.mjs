import fs from 'node:fs/promises';
import path from 'node:path';
import { SegmentManifestError,verifySegmentManifest } from './archive-v2-manifest.mjs';
import { readVersionedManifest } from './archive-v2-generations.mjs';

// Pre-commit validation of a prepared, unpublished generation.
// Caller must hold the writer lock and prevent external filesystem mutation.
export async function verifyPreparedGeneration(root,generation) {
  if(typeof root!=='string'||!root.trim()) throw new SegmentManifestError('Invalid root');
  const base=path.resolve(root);
  const manifest=await readVersionedManifest(base,generation);
  const dir=path.join(base,'segments');
  const entries=(await fs.readdir(dir)).sort();
  const expected=manifest.segments.map(s=>s.file).sort();
  if(entries.length!==expected.length||entries.some((name,i)=>name!==expected[i])) {
    throw new SegmentManifestError('Missing or unexpected segment in prepared generation');
  }
  const contents=Object.create(null);
  for(const descriptor of manifest.segments) {
    const file=path.join(dir,descriptor.file);
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
      if(!after.isFile()||after.isSymbolicLink()||after.dev!==opened.dev||
          after.ino!==opened.ino||after.size!==opened.size) {
        throw new SegmentManifestError('Segment changed during read');
      }
    } finally { await handle.close(); }
  }
  verifySegmentManifest({version:2,segments:manifest.segments,checksum:manifest.segmentChecksum},contents);
  return {generation:manifest.generation,manifestHash:manifest.manifestHash,segments:manifest.segments.length};
}
