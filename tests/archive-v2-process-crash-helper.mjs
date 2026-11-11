import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeImmutableSegment } from '../monitor/archive-v2-segment-io.mjs';
import { buildVersionedManifest,writeVersionedManifest } from '../monitor/archive-v2-generations.mjs';
import { publishInitialHead,readHead } from '../monitor/archive-v2-head.mjs';
import { inspectV2Recovery } from '../monitor/archive-v2-recovery.mjs';

const self=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
const root=process.argv[2];
const fault=process.argv[3];

if(self&&root&&fault) {
  const { acquireV2WriterLock }=await import('../monitor/archive-v2-writer-lock.mjs');
  const { commitPreparedGeneration }=await import('../monitor/archive-v2-commit.mjs');
  const lock=await acquireV2WriterLock(root);
  try {
    await commitPreparedGeneration(root,lock,2,{
      faultAt:fault,
    });
  } catch(error) {
    if(String(error.message).includes('Injected fault:')) process.exit(77);
    throw error;
  } finally {
    await lock.release();
  }
}

export async function runV2ProcessCrashProbe(faultAt) {
  const boundary=faultAt.startsWith('kill-')?faultAt.slice(5):faultAt;
  if(!['after-stage-sync','before-rename','after-rename','after-directory-sync'].includes(boundary)) {
    throw new Error('Unsupported fault boundary');
  }
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-process-crash-'));
  try {
    const a=await writeImmutableSegment(dir,1,'{"id":"a"}\n');
    const first=buildVersionedManifest(1,[a]);
    await writeVersionedManifest(dir,first);
    await publishInitialHead(dir,first);
    const b=await writeImmutableSegment(dir,2,'{"id":"b"}\n');
    const second=buildVersionedManifest(2,[a,b],first.manifestHash);
    await writeVersionedManifest(dir,second);
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url),dir,faultAt],{
        stdio:'ignore',env:process.env,
      });
      child.once('error',reject);
      child.once('exit',(code,signal)=>resolve({code,signal}));
    });
    if(faultAt.startsWith('kill-')) {
      if(result.signal!=='SIGKILL') throw new Error('Expected SIGKILL: '+JSON.stringify(result));
    } else if(result.code!==77) {
      throw new Error('Crash child did not reach fault boundary: '+JSON.stringify(result));
    }
    const head=await readHead(dir);
    const triage=await inspectV2Recovery(dir);
    return {
      faultAt,
      generation:head.generation,
      expectedGeneration:boundary==='after-stage-sync'||boundary==='before-rename'?1:2,
      orphanManifests:triage.orphanManifests,
      stagingFiles:triage.stagingFiles,
      requiresOperatorReview:triage.requiresOperatorReview,
    };
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
