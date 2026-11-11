import fs from 'node:fs/promises';
import path from 'node:path';
import { SegmentManifestError } from './archive-v2-manifest.mjs';
import { readHead } from './archive-v2-head.mjs';
import { generationFile, readVersionedManifest } from './archive-v2-generations.mjs';
import { verifyPublishedChain } from './archive-v2-audit.mjs';

// Read-only crash triage. Does not repair, delete or adopt orphan files.
// Do not use as a substitute for full published-chain verification.
export async function inspectV2Recovery(root) {
  if(typeof root!=='string'||!root.trim()) throw new SegmentManifestError('Invalid root');
  const base=path.resolve(root);
  const head=await readHead(base);
  // Verify committed data before classifying any unreferenced artifacts.
  // A prepared generation may leave orphans; do not call this a clean archive.
  let committedIntegrity;
  try { committedIntegrity=await verifyPublishedChain(base); }
  catch(error) {
    if(!(error instanceof SegmentManifestError)) throw error;
    committedIntegrity=null;
  }
  const committedManifest=await readVersionedManifest(base,head.generation);
  const manifestDir=path.join(base,'manifests');
  const segmentDir=path.join(base,'segments');
  const [manifestNames,segmentNames,rootNames]=await Promise.all([
    fs.readdir(manifestDir),fs.readdir(segmentDir),fs.readdir(base),
  ]);
  const published=new Set(Array.from({length:head.generation},(_,i)=>generationFile(i+1)));
  const orphanManifests=manifestNames.filter(name=>!published.has(name)).sort();
  const stagingFiles=rootNames.filter(name=>name.startsWith('.HEAD-')&&name.endsWith('.tmp')).sort();
  const unexpectedRootFiles=rootNames.filter(name=>name.startsWith('.HEAD-')&&!name.endsWith('.tmp')).sort();
  const committedSegments=new Set(committedManifest.segments.map(s=>s.file));
  const orphanSegments=segmentNames.filter(name=>!committedSegments.has(name)).sort();
  // An orphan is evidence, not proof that its contents are safe to adopt.
  return {
    head,
    orphanManifests,
    stagingFiles,
    unexpectedRootFiles,
    segmentFiles:segmentNames.slice().sort(),
    orphanSegments,
    committedIntegrityVerified:committedIntegrity!==null,
    requiresOperatorReview:committedIntegrity===null||orphanSegments.length>0||orphanManifests.length>0||stagingFiles.length>0||unexpectedRootFiles.length>0,
  };
}
