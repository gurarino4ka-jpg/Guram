import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUdfHistory } from '../monitor/core.mjs';
import { buildArchiveObservation } from '../monitor/archive-adapter.mjs';

const market = {
  schemaVersion:1,provider:'bookflow',providerSymbol:'BTC',providerTicker:'BTC/USDT',
  displayName:'BTC/USD',exchange:null,marketType:'unknown',priceBasis:'unknown',
  quoteAsset:'USD',settlementToken:'USD',resolution:'60',
};

test('warmup history archives all closed candles, not only new events',()=>{
  const snapshotTimeMs=10_800_000;
  const validation=validateUdfHistory({
    s:'ok',t:[0,3600,7200],o:[100,101,102],h:[110,111,112],
    l:[90,91,92],c:[105,106,107]
  },{resolution:'60',nowMs:snapshotTimeMs});
  const observation=buildArchiveObservation({market,validation,snapshotTimeMs,receivedAtMs:snapshotTimeMs+100});
  assert.equal(observation.candles.length,3);
  assert.equal(observation.candles[0].volume,null);
  assert.equal(observation.candles[2].openTimeMs,7_200_000);
});
test('forming candles are excluded',()=>{
  const snapshotTimeMs=7_200_000;
  const validation=validateUdfHistory({
    s:'ok',t:[3600,7200],o:[100,101],h:[110,111],l:[90,91],c:[105,106]
  },{resolution:'60',nowMs:snapshotTimeMs});
  const observation=buildArchiveObservation({market,validation,snapshotTimeMs,receivedAtMs:snapshotTimeMs+100});
  assert.equal(observation.candles.length,1);
});
test('adapter rejects an inconsistent market resolution',()=>{
  const validation=validateUdfHistory({
    s:'ok',t:[3600],o:[100],h:[110],l:[90],c:[105]
  },{resolution:'60',nowMs:7_200_000});
  assert.throws(()=>buildArchiveObservation({market:{...market,resolution:'15'},validation,
    snapshotTimeMs:7_200_000,receivedAtMs:7_200_100}),/matching resolution/);
});
test('adapter rejects observation time before snapshot',()=>{
  const validation=validateUdfHistory({s:'no_data'},{resolution:'60',nowMs:7_200_000});
  assert.throws(()=>buildArchiveObservation({market,validation,
    snapshotTimeMs:7_200_000,receivedAtMs:7_199_999}),/observation times/);
});
