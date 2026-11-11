import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SegmentManifestError, createSegmentManifest } from './archive-v2-manifest.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const validGeneration=n=>Number.isSafeInteger(n)&&n>=1&&n<=999999999999;
export const generationFile=n=>{
  if (!validGeneration(n)) throw new SegmentManifestError('Invalid manifest generation');
  return String(n).padStart(12,'0')+'.json';
};

async function syncDir(dir) {
  if (process.platform==='win32') return;
  const handle=await fs.open(dir,'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export function buildVersionedManifest(generation,descriptors,previousHash=null) {
  if (!validGeneration(generation)) throw new SegmentManifestError('Invalid manifest generation');
  if (generation===1 ? previousHash!==null : typeof previousHash!=='string'||!/^[0-9a-f]{64}$/.test(previousHash)) {
    throw new SegmentManifestError('Invalid previous manifest hash');
  }
  const payload={generation,previousHash,...createSegmentManifest(descriptors)};
  const {checksum:segmentChecksum,...rest}=payload;
  const body={...rest,segmentChecksum};
  return {...body,manifestHash:sha(JSON.stringify(body))};
}

export function verifyVersionedManifest(manifest) {
  if (!manifest||typeof manifest!=='object'||Array.isArray(manifest) ||
      Object.keys(manifest).sort().join(',')!=='generation,manifestHash,previousHash,segmentChecksum,segments,version') {
    throw new SegmentManifestError('Invalid versioned manifest');
  }
  const expected=buildVersionedManifest(manifest.generation,manifest.segments,manifest.previousHash);
  if (JSON.stringify(expected)!==JSON.stringify(manifest)) {
    throw new SegmentManifestError('Versioned manifest mismatch');
  }
  return true;
}

export async function writeVersionedManifest(root,manifest) {
  if (typeof root!=='string'||!root.trim()) throw new SegmentManifestError('Invalid root');
  verifyVersionedManifest(manifest);
  const dir=path.join(path.resolve(root),'manifests');
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const stat=await fs.lstat(dir);
  if (!stat.isDirectory()||stat.isSymbolicLink()) throw new SegmentManifestError('Invalid manifests directory');
  const file=path.join(dir,generationFile(manifest.generation));
  const handle=await fs.open(file,'wx',0o600);
  try {
    await handle.writeFile(JSON.stringify(manifest)+'\n','utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await syncDir(dir);
  return file;
}

export async function readVersionedManifest(root,generation) {
  if (typeof root!=='string'||!root.trim()) throw new SegmentManifestError('Invalid root');
  const file=path.join(path.resolve(root),'manifests',generationFile(generation));
  const before=await fs.lstat(file);
  if (!before.isFile()||before.isSymbolicLink()) throw new SegmentManifestError('Invalid manifest file');
  const handle=await fs.open(file,'r');
  try {
    const opened=await handle.stat();
    if (!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino) {
      throw new SegmentManifestError('Manifest replaced before read');
    }
    const raw=await handle.readFile('utf8');
    const after=await fs.lstat(file);
    if (!after.isFile()||after.isSymbolicLink()||after.dev!==opened.dev||
        after.ino!==opened.ino||after.size!==opened.size) {
      throw new SegmentManifestError('Manifest changed during read');
    }
    if (!raw.endsWith('\n')||raw.indexOf('\n')!==raw.length-1) {
      throw new SegmentManifestError('Invalid manifest framing');
    }
    let manifest;
    try { manifest=JSON.parse(raw.slice(0,-1)); } catch { throw new SegmentManifestError('Invalid manifest JSON'); }
    verifyVersionedManifest(manifest);
    if (manifest.generation!==generation) throw new SegmentManifestError('Generation mismatch');
    return manifest;
  } finally { await handle.close(); }
}
