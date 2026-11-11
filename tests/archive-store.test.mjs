import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCandleArchive, ArchiveStoreError } from '../monitor/archive-store.mjs';

const market = {
  schemaVersion:1,provider:'bookflow',providerSymbol:'BTC',providerTicker:'BTC/USDT',
  displayName:'BTC/USD',exchange:null,marketType:'unknown',priceBasis:'unknown',
  quoteAsset:'USD',settlementToken:'USD',resolution:'60',
};
const candle = {
  openTimeMs:3_600_000,open:100,high:110,low:90,close:105,volume:null,
  snapshotTimeMs:7_200_000,receivedAtMs:7_200_100,knownAtMs:7_200_100,
};
async function fixture(fn) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ca02-'));
  try { await fn(dir); } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
test('new candle, identical observation and correction',async()=>{
  await fixture(async dir=>{
    const archive=await createCandleArchive(dir);
    await archive.open();
    assert.deepEqual(await archive.appendObservation({market,candles:[candle]}),
      {newCandles:1,revisions:0,unchanged:0});
    assert.deepEqual(await archive.appendObservation({market,candles:[candle]}),
      {newCandles:0,revisions:0,unchanged:1});
    const changed={...candle,close:106,knownAtMs:7_300_000,receivedAtMs:7_300_000};
    assert.deepEqual(await archive.appendObservation({market,candles:[changed]}),
      {newCandles:0,revisions:1,unchanged:0});
    assert.equal(archive.getCandle({identity:market,openTimeMs:candle.openTimeMs,asOf:7_250_000}).candle.close,105);
    assert.equal(archive.getCandle({identity:market,openTimeMs:candle.openTimeMs}).candle.close,106);
    assert.equal(archive.getRevisions(market,candle.openTimeMs).length,2);
    await archive.close();
    const reopened=await createCandleArchive(dir);
    await reopened.open();
    assert.equal(reopened.getRevisions(market,candle.openTimeMs).length,2);
    await reopened.close();
  });
});
test('market identity separates streams',async()=>{
  await fixture(async dir=>{
    const archive=await createCandleArchive(dir);await archive.open();
    await archive.appendObservation({market,candles:[candle]});
    assert.equal(archive.getCandle({identity:{...market,priceBasis:'index'},openTimeMs:candle.openTimeMs}),null);
    await archive.close();
  });
});
test('duplicate candle in one batch is rejected',async()=>{
  await fixture(async dir=>{
    const archive=await createCandleArchive(dir);await archive.open();
    await assert.rejects(archive.appendObservation({market,candles:[candle,candle]}),
      e=>e instanceof ArchiveStoreError&&e.code==='duplicate_candle');
    await archive.close();
  });
});
test('archive refuses a second concurrent writer',async()=>{
  await fixture(async dir=>{
    const first=await createCandleArchive(dir),second=await createCandleArchive(dir);
    await first.open();
    await assert.rejects(second.open(),e=>e instanceof ArchiveStoreError&&e.code==='locked');
    await first.close();
  });
});
test('incomplete journal tail fails closed without truncation',async()=>{
  await fixture(async dir=>{
    const first=await createCandleArchive(dir);await first.open();
    await first.appendObservation({market,candles:[candle]});await first.close();
    const file=path.join(dir,'archive','v1','observations.jsonl');
    await fs.appendFile(file,'{"incomplete":');
    const second=await createCandleArchive(dir);
    await assert.rejects(second.open(),e=>e instanceof ArchiveStoreError&&e.code==='corrupt_journal');
    assert.match(await fs.readFile(file,'utf8'),/\{"incomplete":$/);
  });
});
test('journal checksum corruption fails closed',async()=>{
  await fixture(async dir=>{
    const first=await createCandleArchive(dir);await first.open();
    await first.appendObservation({market,candles:[candle]});await first.close();
    const file=path.join(dir,'archive','v1','observations.jsonl');
    const original=await fs.readFile(file,'utf8');
    await fs.writeFile(file,original.replace('"checksum":"','"checksum":"0'));
    const second=await createCandleArchive(dir);
    await assert.rejects(second.open(),e=>e instanceof ArchiveStoreError&&e.code==='corrupt_journal');
  });
});

test('tampered OHLCV is rejected even if batch checksum is recalculated',async()=>{
  await fixture(async dir=>{
    const first=await createCandleArchive(dir);
    await first.open();
    await first.appendObservation({market,candles:[candle]});
    await first.close();
    const file=path.join(dir,'archive','v1','observations.jsonl');
    const batch=JSON.parse(await fs.readFile(file,'utf8'));
    batch.entries[0].candle.close=107;
    const { createHash }=await import('node:crypto');
    const payload=JSON.stringify({version:batch.version,id:batch.id,entries:batch.entries});
    batch.checksum=createHash('sha256').update(payload,'utf8').digest('hex');
    await fs.writeFile(file,JSON.stringify(batch)+'\n');
    const second=await createCandleArchive(dir);
    await assert.rejects(second.open(),e=>e instanceof ArchiveStoreError&&e.code==='corrupt_journal');
  });
});
test('tampered observation time is rejected even if batch checksum is recalculated',async()=>{
  await fixture(async dir=>{
    const first=await createCandleArchive(dir);
    await first.open();
    await first.appendObservation({market,candles:[candle]});
    await first.close();
    const file=path.join(dir,'archive','v1','observations.jsonl');
    const batch=JSON.parse(await fs.readFile(file,'utf8'));
    batch.entries[0].snapshotTimeMs=3_600_000;
    const { createHash }=await import('node:crypto');
    const payload=JSON.stringify({version:batch.version,id:batch.id,entries:batch.entries});
    batch.checksum=createHash('sha256').update(payload,'utf8').digest('hex');
    await fs.writeFile(file,JSON.stringify(batch)+'\n');
    const second=await createCandleArchive(dir);
    await assert.rejects(second.open(),e=>e instanceof ArchiveStoreError&&e.code==='corrupt_journal');
  });
});

test('complete committed batch survives restart and retry without extra revision',async()=>{
  await fixture(async dir=>{
    const first=await createCandleArchive(dir);
    await first.open();
    await first.appendObservation({market,candles:[candle]});
    await first.close();
    const restarted=await createCandleArchive(dir);
    await restarted.open();
    assert.deepEqual(await restarted.appendObservation({market,candles:[candle]}),
      {newCandles:0,revisions:0,unchanged:1});
    assert.equal(restarted.getRevisions(market,candle.openTimeMs).length,1);
    await restarted.close();
  });
});
test('partial second batch blocks replay while preserving committed first batch on disk',async()=>{
  await fixture(async dir=>{
    const first=await createCandleArchive(dir);
    await first.open();
    await first.appendObservation({market,candles:[candle]});
    await first.close();
    const file=path.join(dir,'archive','v1','observations.jsonl');
    const committed=await fs.readFile(file,'utf8');
    await fs.appendFile(file,'{"version":1,"id":"unfinished"');
    const restarted=await createCandleArchive(dir);
    await assert.rejects(restarted.open(),e=>e instanceof ArchiveStoreError&&e.code==='corrupt_journal');
    assert.equal(await fs.readFile(file,'utf8'),committed+'{"version":1,"id":"unfinished"');
  });
});
test('sequential revisions survive multiple committed batches and PIT replay',async()=>{
  await fixture(async dir=>{
    const first=await createCandleArchive(dir);
    await first.open();
    await first.appendObservation({market,candles:[candle]});
    await first.appendObservation({market,candles:[{
      ...candle,close:106,receivedAtMs:7_300_000,knownAtMs:7_300_000,
    }]});
    await first.appendObservation({market,candles:[{
      ...candle,close:105,receivedAtMs:7_400_000,knownAtMs:7_400_000,
    }]});
    await first.close();
    const restarted=await createCandleArchive(dir);
    await restarted.open();
    assert.deepEqual(restarted.getRevisions(market,candle.openTimeMs).map(x=>x.revision),[1,2,3]);
    assert.equal(restarted.getCandle({identity:market,openTimeMs:candle.openTimeMs,asOf:7_350_000}).candle.close,106);
    assert.equal(restarted.getCandle({identity:market,openTimeMs:candle.openTimeMs,asOf:7_450_000}).candle.close,105);
    await restarted.close();
  });
});

test('replaced lock token prevents writes and does not delete replacement',async()=>{
  await fixture(async dir=>{
    const archive=await createCandleArchive(dir);
    await archive.open();
    const lock=path.join(dir,'archive','v1','archive.lock');
    const original=JSON.parse(await fs.readFile(lock,'utf8'));
    const replacement={...original,token:'foreign-owner-token'};
    await fs.writeFile(lock,JSON.stringify(replacement)+'\n');
    await assert.rejects(archive.appendObservation({market,candles:[candle]}),
      e=>e instanceof ArchiveStoreError&&e.code==='lock_changed');
    await assert.rejects(archive.close(),
      e=>e instanceof ArchiveStoreError&&e.code==='lock_changed');
    assert.equal(JSON.parse(await fs.readFile(lock,'utf8')).token,'foreign-owner-token');
  });
});
test('missing archive lock refuses further writes',async()=>{
  await fixture(async dir=>{
    const archive=await createCandleArchive(dir);
    await archive.open();
    const lock=path.join(dir,'archive','v1','archive.lock');
    await fs.unlink(lock);
    await assert.rejects(archive.appendObservation({market,candles:[candle]}),
      e=>e instanceof ArchiveStoreError&&e.code==='lock_changed');
  });
});

test('same archive instance can reopen and replay without duplicate batches',async()=>{
  await fixture(async dir=>{
    const archive=await createCandleArchive(dir);
    await archive.open();
    await archive.appendObservation({market,candles:[candle]});
    await archive.close();
    await archive.open();
    assert.equal(archive.getRevisions(market,candle.openTimeMs).length,1);
    assert.deepEqual(await archive.appendObservation({market,candles:[candle]}),
      {newCandles:0,revisions:0,unchanged:1});
    await archive.close();
  });
});

test('stale-looking lock is not automatically removed or overwritten',async()=>{
  await fixture(async dir=>{
    const archive=await createCandleArchive(dir);
    const lock=path.join(dir,'archive','v1','archive.lock');
    const stale=JSON.stringify({pid:99999999,token:'prior-process',createdAt:'2020-01-01T00:00:00.000Z'})+'\n';
    await fs.writeFile(lock,stale);
    await assert.rejects(archive.open(),
      e=>e instanceof ArchiveStoreError&&e.code==='locked');
    assert.equal(await fs.readFile(lock,'utf8'),stale);
  });
});

test('archive refuses reads before opening and after closing',async()=>{
  await fixture(async dir=>{
    const archive=await createCandleArchive(dir);
    const read=()=>archive.getCandle({identity:market,openTimeMs:candle.openTimeMs});
    const revisions=()=>archive.getRevisions(market,candle.openTimeMs);
    assert.throws(read,e=>e instanceof ArchiveStoreError&&e.code==='not_ready');
    assert.throws(revisions,e=>e instanceof ArchiveStoreError&&e.code==='not_ready');
    await archive.open();
    await archive.appendObservation({market,candles:[candle]});
    assert.equal(read().candle.close,105);
    await archive.close();
    assert.throws(read,e=>e instanceof ArchiveStoreError&&e.code==='not_ready');
    assert.throws(revisions,e=>e instanceof ArchiveStoreError&&e.code==='not_ready');
  });
});

test('replacing lock inode with same token refuses writes and preserves foreign lock',async()=>{
  await fixture(async dir=>{
    const archive=await createCandleArchive(dir);
    await archive.open();
    const lock=path.join(dir,'archive','v1','archive.lock');
    const original=await fs.readFile(lock,'utf8');
    const replacement=lock+'.replacement';
    await fs.writeFile(replacement,original);
    await fs.rename(replacement,lock);
    await assert.rejects(archive.appendObservation({market,candles:[candle]}),
      e=>e instanceof ArchiveStoreError&&e.code==='lock_changed');
    await assert.rejects(archive.close(),
      e=>e instanceof ArchiveStoreError&&e.code==='lock_changed');
    assert.equal(await fs.readFile(lock,'utf8'),original);
  });
});

test('interrupted second batch preserves committed bytes and blocks restart',async()=>{
  await fixture(async dir=>{
    const first=await createCandleArchive(dir);
    await first.open();
    await first.appendObservation({market,candles:[candle]});
    await first.close();
    const journal=path.join(dir,'archive','v1','observations.jsonl');
    const committed=await fs.readFile(journal);
    const torn=Buffer.from('{"version":1,"id":"interrupted"', 'utf8');
    await fs.appendFile(journal,torn);
    const damaged=await fs.readFile(journal);
    assert.deepEqual(damaged.subarray(0,committed.length),committed);
    const second=await createCandleArchive(dir);
    await assert.rejects(second.open(),
      e=>e instanceof ArchiveStoreError&&e.code==='corrupt_journal');
    assert.deepEqual(await fs.readFile(journal),damaged);
    const lock=path.join(dir,'archive','v1','archive.lock');
    await assert.rejects(fs.access(lock),e=>e.code==='ENOENT');
    // Offline repair is explicit and occurs only after preserving the damaged bytes.
    const backup=journal+'.damaged';
    await fs.copyFile(journal,backup);
    await fs.writeFile(journal,committed);
    const recovered=await createCandleArchive(dir);
    await recovered.open();
    assert.equal(recovered.getRevisions(market,candle.openTimeMs).length,1);
    await recovered.close();
    assert.deepEqual(await fs.readFile(backup),damaged);
  });
});

test('lock disappearance during operation refuses further writes and does not recreate lock',async()=>{
  await fixture(async dir=>{
    const archive=await createCandleArchive(dir);
    await archive.open();
    await archive.appendObservation({market,candles:[candle]});
    const journal=path.join(dir,'archive','v1','observations.jsonl');
    const before=await fs.readFile(journal);
    const lock=path.join(dir,'archive','v1','archive.lock');
    await fs.unlink(lock);
    const correction={...candle,close:106,receivedAtMs:7_300_000,knownAtMs:7_300_000};
    await assert.rejects(archive.appendObservation({market,candles:[correction]}),
      e=>e instanceof ArchiveStoreError&&e.code==='lock_changed');
    assert.deepEqual(await fs.readFile(journal),before);
    await assert.rejects(archive.close(),
      e=>e instanceof ArchiveStoreError&&e.code==='lock_changed');
    await assert.rejects(fs.access(lock),e=>e.code==='ENOENT');
  });
});

test('simultaneous archive open attempts allow exactly one writer',async()=>{
  await fixture(async dir=>{
    const a=await createCandleArchive(dir);
    const b=await createCandleArchive(dir);
    const outcomes=await Promise.allSettled([a.open(),b.open()]);
    const winners=outcomes.filter(x=>x.status==='fulfilled');
    const losers=outcomes.filter(x=>x.status==='rejected');
    assert.equal(winners.length,1);
    assert.equal(losers.length,1);
    assert.equal(losers[0].reason.code,'locked');
    const winner=outcomes[0].status==='fulfilled'?a:b;
    const loser=winner===a?b:a;
    await winner.appendObservation({market,candles:[candle]});
    await winner.close();
    await loser.open();
    assert.equal(loser.getRevisions(market,candle.openTimeMs).length,1);
    await loser.close();
  });
});

test('former owner cannot append after another archive takes over a replaced lock',async()=>{
  await fixture(async dir=>{
    const first=await createCandleArchive(dir);
    await first.open();
    await first.appendObservation({market,candles:[candle]});
    const lock=path.join(dir,'archive','v1','archive.lock');
    const journal=path.join(dir,'archive','v1','observations.jsonl');
    // Simulate unsafe external deletion: never do this during normal operation.
    await fs.unlink(lock);
    const second=await createCandleArchive(dir);
    await second.open();
    const corrected={...candle,close:106,receivedAtMs:7_300_000,knownAtMs:7_300_000};
    await second.appendObservation({market,candles:[corrected]});
    const before=await fs.readFile(journal);
    await assert.rejects(first.appendObservation({market,candles:[corrected]}),
      e=>e instanceof ArchiveStoreError&&e.code==='lock_changed');
    assert.deepEqual(await fs.readFile(journal),before);
    await assert.rejects(first.close(),
      e=>e instanceof ArchiveStoreError&&e.code==='lock_changed');
    await second.close();
    const replay=await createCandleArchive(dir);
    await replay.open();
    assert.equal(replay.getRevisions(market,candle.openTimeMs).length,2);
    await replay.close();
  });
});

test('failed close after lock takeover releases local descriptor and disables stale reads',async()=>{
  await fixture(async dir=>{
    const first=await createCandleArchive(dir);
    await first.open();
    await first.appendObservation({market,candles:[candle]});
    const lock=path.join(dir,'archive','v1','archive.lock');
    await fs.unlink(lock);
    const second=await createCandleArchive(dir);
    await second.open();
    await assert.rejects(first.close(),
      e=>e instanceof ArchiveStoreError&&e.code==='lock_changed');
    assert.throws(()=>first.getRevisions(market,candle.openTimeMs),
      e=>e instanceof ArchiveStoreError&&e.code==='not_ready');
    await second.close();
    const reopened=await createCandleArchive(dir);
    await reopened.open();
    assert.equal(reopened.getRevisions(market,candle.openTimeMs).length,1);
    await reopened.close();
  });
});

test('after lost ownership close is idempotent and a stale writer cannot reopen through successor lock',async()=>{
  await fixture(async dir=>{
    const first=await createCandleArchive(dir);
    await first.open();
    const lock=path.join(dir,'archive','v1','archive.lock');
    await fs.unlink(lock);
    const successor=await createCandleArchive(dir);
    await successor.open();
    await assert.rejects(first.close(),
      e=>e instanceof ArchiveStoreError&&e.code==='lock_changed');
    await first.close();
    await assert.rejects(first.open(),
      e=>e instanceof ArchiveStoreError&&e.code==='locked');
    await successor.appendObservation({market,candles:[candle]});
    await successor.close();
    await first.open();
    assert.equal(first.getRevisions(market,candle.openTimeMs).length,1);
    await first.close();
  });
});

test('journal symlink replacement fails closed without modifying its target',async()=>{
  await fixture(async dir=>{
    const archive=await createCandleArchive(dir);
    await archive.open();
    await archive.appendObservation({market,candles:[candle]});
    const journal=path.join(dir,'archive','v1','observations.jsonl');
    const moved=journal+'.saved';
    await fs.rename(journal,moved);
    try {
      await fs.symlink(moved,journal);
    } catch (error) {
      if (error.code==='EPERM' || error.code==='EACCES') {
        await fs.rename(moved,journal);
        await archive.close();
        return;
      }
      throw error;
    }
    const before=await fs.readFile(moved);
    const correction={...candle,close:106,receivedAtMs:7_300_000,knownAtMs:7_300_000};
    await assert.rejects(archive.appendObservation({market,candles:[correction]}),
      e=>e instanceof ArchiveStoreError&&e.code==='write_failed');
    assert.deepEqual(await fs.readFile(moved),before);
    await archive.close();
  });
});
