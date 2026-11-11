import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SegmentManifestError } from './archive-v2-manifest.mjs';
import { readHead } from './archive-v2-head.mjs';
import { readVersionedManifest } from './archive-v2-generations.mjs';
import { validateHeadTransition } from './archive-v2-transition.mjs';
import { verifyPreparedGeneration } from './archive-v2-precommit.mjs';

// EXPERIMENTAL: local filesystem, cooperating single writer, no external mutations.
// Rename is atomic on supported same-filesystem targets, but is not a compare-and-swap.
// A crash after rename and before directory sync leaves durability uncertain.
export async function commitPreparedGeneration(root,lock,generation,{faultAt=null}={}) {
  const checkpoint=async name=>{
    if(faultAt===name) throw new SegmentManifestError('Injected fault: '+name);
  };
  if(typeof root!=='string'||!root.trim()||!lock||typeof lock.assertOwned!=='function') {
    throw new SegmentManifestError('Archive root and writer lock required');
  }
  const base=path.resolve(root);
  await lock.assertOwned();
  const current=await readHead(base);
  const previous=await readVersionedManifest(base,current.generation);
  const next=await readVersionedManifest(base,generation);
  const desired=validateHeadTransition(current,next,previous);
  const verified=await verifyPreparedGeneration(base,generation);
  if(verified.manifestHash!==desired.manifestHash) {
    throw new SegmentManifestError('Prepared manifest changed');
  }
  await lock.assertOwned();
  const again=await readHead(base);
  if(again.generation!==current.generation||again.manifestHash!==current.manifestHash) {
    throw new SegmentManifestError('HEAD changed before commit');
  }
  const staged=path.join(base,'.HEAD-'+randomUUID()+'.tmp');
  const handle=await fs.open(staged,'wx',0o600);
  let closed=false;
  let committed=false;
  try {
    await handle.writeFile(JSON.stringify(desired)+'\n','utf8');
    await handle.sync();
    await checkpoint('after-stage-sync');
    await handle.close();
    closed=true;
    await lock.assertOwned();
    const latest=await readHead(base);
    if(latest.generation!==current.generation||latest.manifestHash!==current.manifestHash) {
      throw new SegmentManifestError('HEAD changed before rename');
    }
    await checkpoint('before-rename');
    await fs.rename(staged,path.join(base,'HEAD'));
    committed=true;
    await checkpoint('after-rename');
    if(process.platform!=='win32') {
      const dir=await fs.open(base,'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
    await checkpoint('after-directory-sync');
    await lock.assertOwned();
    const published=await readHead(base);
    if(published.generation!==desired.generation||published.manifestHash!==desired.manifestHash) {
      throw new SegmentManifestError('Published HEAD mismatch');
    }
    return published;
  } finally {
    if(!closed) await handle.close().catch(()=>{});
    if(!committed) await fs.unlink(staged).catch(()=>{});
  }
}
