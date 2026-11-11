import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SegmentManifestError } from './archive-v2-manifest.mjs';

// Advisory local-filesystem writer lease. This is not distributed fencing.
export async function acquireV2WriterLock(root) {
  if(typeof root!=='string'||!root.trim()) throw new SegmentManifestError('Invalid root');
  const base=path.resolve(root);
  const rootStat=await fs.lstat(base);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink()) throw new SegmentManifestError('Invalid archive root');
  const file=path.join(base,'archive.lock');
  const token=randomUUID();
  const handle=await fs.open(file,'wx',0o600);
  let released=false;
  try {
    await handle.writeFile(token+'\n','utf8');
    await handle.sync();
    const opened=await handle.stat();
    async function assertOwned() {
      if(released) throw new SegmentManifestError('Writer lock released');
      let current;
      try { current=await fs.lstat(file); }
      catch { throw new SegmentManifestError('Writer lock disappeared'); }
      if(!current.isFile()||current.isSymbolicLink()||
          current.dev!==opened.dev||current.ino!==opened.ino||
          current.size!==opened.size) {
        throw new SegmentManifestError('Writer lock ownership lost');
      }
      if((await fs.readFile(file,'utf8'))!==token+'\n') {
        throw new SegmentManifestError('Writer lock token changed');
      }
      const after=await fs.lstat(file);
      if(after.dev!==opened.dev||after.ino!==opened.ino) {
        throw new SegmentManifestError('Writer lock replaced during verification');
      }
      return true;
    }
    async function release() {
      if(released) return;
      released=true;
      try {
        const current=await fs.lstat(file);
        if(current.isFile()&&!current.isSymbolicLink()&&
            current.dev===opened.dev&&current.ino===opened.ino) {
          // No automatic cleanup if ownership was lost or token modified.
          if((await fs.readFile(file,'utf8'))===token+'\n') await fs.unlink(file);
        }
      } catch(e) { if(e.code!=='ENOENT') throw e; }
      finally { await handle.close(); }
    }
    return {assertOwned,release};
  } catch(error) {
    await handle.close();
    // Preserve lock file as forensic evidence if acquisition failed after creation.
    throw error;
  }
}
