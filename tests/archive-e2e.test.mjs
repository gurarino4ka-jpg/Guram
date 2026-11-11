import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../monitor/store.mjs';
import { createCandleArchive } from '../monitor/archive-store.mjs';
import { collectOnce } from '../monitor/collector.mjs';

const config={mode:'data-only',symbols:['BTC'],resolutions:['60'],pollSeconds:60,
  countback:50,timeoutSeconds:10,maxQuoteAgeSeconds:120,maxClosedLagPeriods:1,dataDir:'unused'};
const market={schemaVersion:1,provider:'bookflow',providerSymbol:'BTC',
  providerTicker:'BTC/USDT',displayName:'BTC/USD',exchange:null,
  marketType:'unknown',priceBasis:'unknown',quoteAsset:'USD',settlementToken:'USD',resolution:'60'};
test('real monitor store + archive: warmup, correction, restart, point-in-time replay',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'archive-e2e-'));
  let store,archive;
  try {
    store=await createStore(dir);
    await store.acquireLock();
    archive=await createCandleArchive(dir);
    await archive.open();
    let receivedAtMs=7_200_100;
    let close=105;
    const provider={
      fetchQuotes:async()=>({quotes:[],receivedAtMs}),
      fetchHistory:async()=>({
        payload:{s:'ok',t:[0,3600],o:[100,100],h:[110,110],
          l:[90,90],c:[104,close]},
        snapshotTimeMs:7_200_000,receivedAtMs,sourceUrl:'https://example.invalid/fixture',
      }),
    };
    const args=()=>({provider,store,archive,config:{...config,dataDir:dir},
      resolveArchiveMarket:()=>market,now:()=>receivedAtMs});
    const first=await collectOnce(args());
    assert.equal(first.status.mode,'data-only');
    assert.equal(archive.getRevisions(market,3_600_000).length,1);
    await collectOnce({...args(),previousState:first.state});
    assert.equal(archive.getRevisions(market,3_600_000).length,1);
    receivedAtMs=7_300_000;
    close=106;
    const revised=await collectOnce({...args(),previousState:first.state});
    assert.equal(revised.status.mode,'data-only');
    assert.equal(archive.getRevisions(market,3_600_000).length,2);
    await archive.close();
    await store.releaseLock();
    archive=await createCandleArchive(dir);
    await archive.open();
    assert.equal(archive.getCandle({identity:market,openTimeMs:3_600_000,asOf:7_250_000}).candle.close,105);
    assert.equal(archive.getCandle({identity:market,openTimeMs:3_600_000}).candle.close,106);
  } finally {
    if(archive) await archive.close().catch(()=>{});
    if(store) await store.releaseLock().catch(()=>{});
    await fs.rm(dir,{recursive:true,force:true});
  }
});
