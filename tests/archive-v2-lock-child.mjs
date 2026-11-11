import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireV2WriterLock } from '../monitor/archive-v2-writer-lock.mjs';

const self=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(self&&process.argv[2]) {
  const root=process.argv[2];
  const mode=process.argv[3];
  try {
    const lock=await acquireV2WriterLock(root);
    process.stdout.write('ACQUIRED\n');
    if(mode==='hold') {
      await new Promise(resolve=>{
        process.stdin.once('data',resolve);
        process.stdin.resume();
      });
    }
    await lock.release();
    process.exit(0);
  } catch(error) {
    if(error?.code==='EEXIST') process.exit(42);
    process.stderr.write(String(error?.message)+'\n');
    process.exit(43);
  }
}
