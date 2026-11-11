import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,rm,rmdir,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoAccountCheckpointStore } from '../monitor/demo-account-checkpoint-store.mjs';
import { ReadOnlyTransportError } from '../monitor/readonly-transport.mjs';

const initial={accountId:'demo_123',asOf:'2026-11-11T05:59:30.000Z'};
const newer={...initial,asOf:'2026-11-11T05:59:31.000Z'};

// Simulate a writer killed immediately after acquiring the *same* atomic
// mkdir lock used by the checkpoint store. Do not auto-expire abandoned locks.
test('a killed lock holder leaves writes fail-closed until verified manual recovery',{timeout:15000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'demo-checkpoint-crash-'));
  const filePath=join(dir,'checkpoint.json');
  const lockPath=filePath+'.lock';
  const store=createDemoAccountCheckpointStore({filePath});
  let child;
  try {
    await store.save(initial);
    const script=[
      "const {mkdirSync}=require('node:fs');",
      'mkdirSync(process.argv[1]);',
      "process.stdout.write('LOCKED\\n');",
      'setInterval(()=>{},1000000);',
    ].join('');
    child=spawn(process.execPath,['-e',script,lockPath],{
      stdio:['ignore','pipe','pipe'],
      windowsHide:true,
    });
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>finish(new Error('Child lock acquisition timed out')),5000);
      const onData=chunk=>String(chunk).includes('LOCKED')?finish():finish(new Error('Unexpected child output'));
      const onError=error=>finish(error);
      const onExit=()=>finish(new Error('Child exited before lock acquisition'));
      function finish(error) {
        clearTimeout(timeout);
        child.stdout.off('data',onData);
        child.off('error',onError);
        child.off('exit',onExit);
        if(error) reject(error); else resolve();
      }
      child.stdout.on('data',onData);
      child.once('error',onError);
      child.once('exit',onExit);
    });
    assert.equal((await stat(lockPath)).isDirectory(),true);
    const exited=once(child,'exit');
    assert.equal(child.kill('SIGKILL'),true);
    await exited;
    assert.equal((await stat(lockPath)).isDirectory(),true);
    await assert.rejects(store.save(newer),ReadOnlyTransportError);
    assert.deepEqual(await store.load(),initial);
    // An operator may remove the lock only after verifying no writer remains.
    await rmdir(lockPath);
    await store.save(newer);
    assert.deepEqual(await store.load(),newer);
  } finally {
    if(child&&child.exitCode===null&&child.signalCode===null) {
      const exited=once(child,'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await rm(dir,{recursive:true,force:true});
  }
});
