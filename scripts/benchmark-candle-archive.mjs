import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCandleArchive } from '../monitor/archive-store.mjs';

// Synthetic, opt-in benchmark. Not a CI performance threshold and not a market-data backtest.
const count = Number(process.argv[2] ?? 1000);
if (!Number.isSafeInteger(count) || count < 1 || count > 10000) {
  throw new Error('Usage: node scripts/benchmark-candle-archive.mjs [1..10000]');
}
const market = {
  schemaVersion:1,provider:'synthetic',providerSymbol:'TEST',providerTicker:null,
  displayName:null,exchange:null,marketType:'unknown',priceBasis:'unknown',
  quoteAsset:null,settlementToken:null,resolution:'60',
};
const dir = await fs.mkdtemp(path.join(os.tmpdir(),'candle-archive-bench-'));
try {
  const archive = await createCandleArchive(dir);
  await archive.open();
  const start = performance.now();
  const batchSize = 100;
  for (let startIndex=0; startIndex<count; startIndex+=batchSize) {
    const candles=[];
    for (let i=startIndex;i<Math.min(startIndex+batchSize,count);i++) {
      const openTimeMs=i*3_600_000;
      candles.push({
        openTimeMs,open:100+i/100,high:101+i/100,low:99+i/100,close:100.5+i/100,
        volume:null,snapshotTimeMs:openTimeMs+3_600_000,
        receivedAtMs:openTimeMs+3_600_001,knownAtMs:openTimeMs+3_600_001,
      });
    }
    await archive.appendObservation({market,candles});
  }
  const appendMs=performance.now()-start;
  await archive.close();
  const journal=path.join(dir,'archive','v1','observations.jsonl');
  const bytes=(await fs.stat(journal)).size;
  const replay=await createCandleArchive(dir);
  const replayStart=performance.now();
  await replay.open();
  const replayMs=performance.now()-replayStart;
  const first=replay.getRevisions(market,0);
  const last=replay.getRevisions(market,(count-1)*3_600_000);
  if (first.length!==1 || last.length!==1) throw new Error('Replay verification failed');
  await replay.close();
  console.log(JSON.stringify({syntheticCandles:count,batches:Math.ceil(count/batchSize),
    appendMs:Math.round(appendMs),replayMs:Math.round(replayMs),
    journalBytes:bytes,heapUsedBytes:process.memoryUsage().heapUsed},null,2));
} finally {
  await fs.rm(dir,{recursive:true,force:true});
}
