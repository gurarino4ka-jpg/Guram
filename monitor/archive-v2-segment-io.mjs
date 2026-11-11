import fs from 'node:fs/promises';
import path from 'node:path';
import { createSegmentDescriptor, segmentName, SegmentManifestError } from './archive-v2-manifest.mjs';

async function syncDir(dir) {
  if (process.platform==='win32') return;
  const handle=await fs.open(dir,'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writeImmutableSegment(root,number,content) {
  if (typeof root!=='string' || !root.trim()) throw new SegmentManifestError('Invalid root');
  const descriptor=createSegmentDescriptor(number,content);
  const segmentsDir=path.join(path.resolve(root),'segments');
  // The caller must prepare an exclusive, trusted archive root before use.
  await fs.mkdir(segmentsDir,{recursive:true,mode:0o700});
  const dirStat=await fs.lstat(segmentsDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new SegmentManifestError('Invalid segments directory');
  }
  const target=path.join(segmentsDir,segmentName(number));
  // O_EXCL prevents overwriting existing data, including symlinks.
  const handle=await fs.open(target,'wx',0o600);
  try {
    await handle.writeFile(content,'utf8');
    await handle.sync();
    const written=await handle.stat();
    if (!written.isFile() || written.size!==descriptor.bytes) {
      throw new SegmentManifestError('Segment write size mismatch');
    }
  } finally {
    await handle.close();
  }
  await syncDir(segmentsDir);
  const verified=await fs.lstat(target);
  if (!verified.isFile() || verified.isSymbolicLink() ||
      verified.size!==descriptor.bytes) {
    throw new SegmentManifestError('Segment identity changed');
  }
  return descriptor;
}
