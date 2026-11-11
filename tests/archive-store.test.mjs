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
