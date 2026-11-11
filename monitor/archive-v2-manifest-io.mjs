import fs from 'node:fs/promises';
import path from 'node:path';
import { createSegmentManifest, verifySegmentManifest, SegmentManifestError } from './archive-v2-manifest.mjs';

async function syncDir(dir) {
  if (process.platform==='win32') return;
  const handle=await fs.open(dir,'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function publishInitialManifest(root,descriptors) {
  if (typeof root!=='string' || !root.trim()) throw new SegmentManifestError('Invalid archive root');
  const dir=path.resolve(root);
  const stat=await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SegmentManifestError('Invalid archive root');
  const manifest=createSegmentManifest(descriptors);
  const contents=Object.create(null);
  for (const descriptor of manifest.segments) {
    const file=path.join(dir,'segments',descriptor.file);
    const before=await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new SegmentManifestError('Invalid segment file');
    const handle=await fs.open(file,'r');
    try {
      const opened=await handle.stat();
      if (!opened.isFile() || opened.dev!==before.dev || opened.ino!==before.ino) {
        throw new SegmentManifestError('Segment replaced before verification');
      }
      contents[descriptor.file]=await handle.readFile('utf8');
      const after=await fs.lstat(file);
      if (!after.isFile() || after.isSymbolicLink() ||
          after.dev!==opened.dev || after.ino!==opened.ino ||
          after.size!==opened.size) throw new SegmentManifestError('Segment changed during verification');
    } finally { await handle.close(); }
  }
  verifySegmentManifest(manifest,contents);
  // Exclusive creation: never replace an existing published manifest.
  const target=path.join(dir,'manifest.json');
  const handle=await fs.open(target,'wx',0o600);
  try {
    await handle.writeFile(JSON.stringify(manifest)+'\n','utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await syncDir(dir);
  return manifest;
}

export async function readInitialManifest(root) {
  if (typeof root!=='string' || !root.trim()) throw new SegmentManifestError('Invalid archive root');
  const file=path.join(path.resolve(root),'manifest.json');
  const before=await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new SegmentManifestError('Invalid manifest file');
  const handle=await fs.open(file,'r');
  try {
    const opened=await handle.stat();
    if (!opened.isFile() || opened.dev!==before.dev || opened.ino!==before.ino) {
      throw new SegmentManifestError('Manifest replaced before read');
    }
    const data=await handle.readFile('utf8');
    const after=await fs.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() ||
        after.dev!==opened.dev || after.ino!==opened.ino ||
        after.size!==opened.size) throw new SegmentManifestError('Manifest changed during read');
    if (!data.endsWith('\n') || data.indexOf('\n')!==data.length-1) {
      throw new SegmentManifestError('Invalid manifest framing');
    }
    const manifest=JSON.parse(data.slice(0,-1));
    if (!manifest || typeof manifest!=='object' || !Array.isArray(manifest.segments) ||
        createSegmentManifest(manifest.segments).checksum!==manifest.checksum) {
      throw new SegmentManifestError('Manifest checksum mismatch');
    }
    return manifest;
  } finally { await handle.close(); }
}
