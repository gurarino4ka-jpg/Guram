import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireV2WriterLock } from '../monitor/archive-v2-writer-lock.mjs';

const childFile=fileURLToPath(new URL('./archive-v2-lock-child.mjs',import.meta.url));
async function runChild(root,mode) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[childFile,root,mode],{stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>stdout+=chunk);
    child.stderr.on('data',chunk=>stderr+=chunk);
    child.once('error',reject);
    child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
  });
}
test('independent process cannot take writer lock held by parent',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-lock-process-'));
  try {
    const lock=await acquireV2WriterLock(root);
    try {
      const result=await runChild(root,'once');
      assert.equal(result.code,42,result.stderr);
      assert.equal(result.stdout,'');
      assert.equal(await lock.assertOwned(),true);
    } finally { await lock.release(); }
    const result=await runChild(root,'once');
    assert.equal(result.code,0,result.stderr);
    assert.match(result.stdout,/ACQUIRED/);
    await assert.rejects(fs.stat(path.join(root,'archive.lock')),{code:'ENOENT'});
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
test('SIGKILL holder leaves lock and refuses silent takeover', {
  skip:process.platform==='win32'?'POSIX signal semantics required':false,
},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ca-v2-lock-sigkill-'));
  try {
    const holder=spawn(process.execPath,[childFile,root,'hold'],{stdio:['pipe','pipe','pipe']});
    try {
      await new Promise((resolve,reject)=>{
        let output='';
        holder.once('error',reject);
        holder.stdout.on('data',chunk=>{
          output+=chunk;
          if(output.includes('ACQUIRED')) resolve();
        });
        holder.once('exit',(code,signal)=>reject(new Error('Holder exited before lock: '+code+'/'+signal)));
      });
      const competing=await runChild(root,'once');
      assert.equal(competing.code,42,competing.stderr);
      holder.kill('SIGKILL');
      const signal=await new Promise(resolve=>holder.once('exit',(_code,sig)=>resolve(sig)));
      assert.equal(signal,'SIGKILL');
      const after=await runChild(root,'once');
      assert.equal(after.code,42,after.stderr);
      assert.equal((await fs.stat(path.join(root,'archive.lock'))).isFile(),true);
    } finally {
      if(holder.exitCode===null&&holder.signalCode===null) holder.kill('SIGKILL');
    }
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
