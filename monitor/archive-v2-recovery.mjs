import fs from 'node:fs/promises';
import path from 'node:path';
import { SegmentManifestError } from './archive-v2-manifest.mjs';
import { readHead } from './archive-v2-head.mjs';
import { generationFile } from './archive-v2-generations.mjs';

// Read-only crash triage. Does not repair, delete or adopt orphan files.
// Do not use as a substitute for full published-chain verification.
export async function inspectV2Recovery(root) {
  if(typeof root!=='string'||!root.trim()) throw new SegmentManifestError('Invalid root');
  const base=path.resolve(root);
  const head=await readHead(base);
  const manifestDir=path.join(base,'manifests');
  const segmentDir=path.join(base,'segments');
  const [manifestNames,segmentNames,rootNames]=await Promise.all([
    fs.readdir(manifestDir),fs.readdir(segmentDir),fs.readdir(base),
  ]);
  const published=new Set(Array.from({length:head.generation},(_,i)=>generationFile(i+1)));
  const orphanManifests=manifestNames.filter(name=>!published.has(name)).sort();
  const stagingFiles=rootNames.filter(name=>name.startsWith('.HEAD-')&&name.endsWith('.tmp')).sort();
  const unexpectedRootFiles=rootNames.filter(name=>name.startsWith('.HEAD-')&&!name.endsWith('.tmp')).sort();
  // Segment orphan classification requires a fully validated committed manifest.
  // Never assume a segment is orphaned from filename or generation alone.
  return {
    head,
    orphanManifests,
    stagingFiles,
    unexpectedRootFiles,
    segmentFiles:segmentNames.slice().sort(),
    requiresOperatorReview:orphanManifests.length>0||stagingFiles.length>0||unexpectedRootFiles.length>0,
  };
}
