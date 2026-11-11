import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SegmentManifestError } from './archive-v2-manifest.mjs';
import { readVersionedManifest } from './archive-v2-generations.mjs';

const hash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);

export function validateHead(head) {
  if (!head||typeof head!=='object'||Array.isArray(head)||
      Object.keys(head).sort().join(',')!=='generation,manifestHash'||
      !Number.isSafeInteger(head.generation)||head.generation<1||
      head.generation>999999999999||!hash(head.manifestHash)) {
    throw new SegmentManifestError('Invalid HEAD');
  }
  return head;
}

async function syncDirectory(dir) {
  if(process.platform==='win32') return;
  const handle=await fs.open(dir,'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function readHead(root) {
  if(typeof root!=='string'||!root.trim()) throw new SegmentManifestError('Invalid root');
  const file=path.join(path.resolve(root),'HEAD');
  const before=await fs.lstat(file);
  if(!before.isFile()||before.isSymbolicLink()) throw new SegmentManifestError('Invalid HEAD file');
  const handle=await fs.open(file,'r');
  try {
    const opened=await handle.stat();
    if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino) {
      throw new SegmentManifestError('HEAD replaced before read');
    }
    const raw=await handle.readFile('utf8');
    const after=await fs.lstat(file);
    if(!after.isFile()||after.isSymbolicLink()||after.dev!==opened.dev||
        after.ino!==opened.ino||after.size!==opened.size) {
      throw new SegmentManifestError('HEAD changed during read');
    }
    if(!raw.endsWith('\n')||raw.indexOf('\n')!==raw.length-1) {
      throw new SegmentManifestError('Invalid HEAD framing');
    }
    let value;
    try { value=JSON.parse(raw.slice(0,-1)); }
    catch { throw new SegmentManifestError('Invalid HEAD JSON'); }
    validateHead(value);
    const manifest=await readVersionedManifest(root,value.generation);
    if(manifest.manifestHash!==value.manifestHash) {
      throw new SegmentManifestError('HEAD manifest hash mismatch');
    }
    return value;
  } finally { await handle.close(); }
}

// Initial publication only. A later rotation must use an explicit
// generation-CAS protocol, not overwrite this HEAD.
export async function publishInitialHead(root,manifest) {
  if(typeof root!=='string'||!root.trim()) throw new SegmentManifestError('Invalid root');
  if(!manifest||manifest.generation!==1||!hash(manifest.manifestHash)) {
    throw new SegmentManifestError('Initial HEAD requires generation 1');
  }
  const dir=path.resolve(root);
  const stat=await fs.lstat(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink()) throw new SegmentManifestError('Invalid root directory');
  const stored=await readVersionedManifest(dir,1);
  if(stored.manifestHash!==manifest.manifestHash) {
    throw new SegmentManifestError('Manifest mismatch');
  }
  // Stage in the same directory and exclusively link to HEAD.
  // Hard-link publication is no-overwrite even with concurrent initializers.
  const staged=path.join(dir,'.HEAD-'+randomUUID()+'.tmp');
  const handle=await fs.open(staged,'wx',0o600);
  let linked=false;
  try {
    await handle.writeFile(JSON.stringify({generation:1,manifestHash:manifest.manifestHash})+'\n','utf8');
    await handle.sync();
    await handle.close();
    await fs.link(staged,path.join(dir,'HEAD'));
    linked=true;
    await syncDirectory(dir);
    return {generation:1,manifestHash:manifest.manifestHash};
  } finally {
    await handle.close().catch(()=>{});
    await fs.unlink(staged).catch(()=>{});
    if(linked) await syncDirectory(dir);
  }
}
