import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOnce } from '../monitor/collector.mjs';

const config={
  mode:'data-only',symbols:['BTC'],resolutions:['60'],pollSeconds:60,countback:50,
  timeoutSeconds:10,maxQuoteAgeSeconds:120,maxClosedLagPeriods:1,dataDir:'unused',
};
const market={
  schemaVersion:1,provider:'bookflow',providerSymbol:'BTC',providerTicker:'BTC/USDT',
  displayName:'BTC/USD',exchange:null,marketType:'unknown',priceBasis:'unknown',
  quoteAsset:'USD',settlementToken:'USD',resolution:'60',
};
function setup() {
  const actions=[];
  const provider={
    fetchQuotes:async()=>({quotes:[],receivedAtMs:7_200_100}),
    fetchHistory:async()=>({
      payload:{s:'ok',t:[0,3600],o:[100,101],h:[110,111],l:[90,91],c:[105,106]},
      snapshotTimeMs:7_200_000,receivedAtMs:7_200_100,sourceUrl:'https://example.invalid/history',
    }),
  };
  const store={
    writeSnapshot:async()=>{actions.push('snapshot');},
    appendEvents:async()=>{actions.push('events');return 0;},
    writeState:async()=>{actions.push('state');},
    writeStatus:async()=>{actions.push('status');},
  };
  return {actions,provider,store};
}
test('disabled archive keeps existing collector write path',async()=>{
  const {actions,provider,store}=setup();
  const result=await collectOnce({provider,store,config,now:()=>7_200_100});
  assert.equal(result.status.mode,'data-only');
  assert.deepEqual(actions,['snapshot','events','state','status']);
});
test('enabled archive receives full warmup history before snapshot',async()=>{
  const {actions,provider,store}=setup();
  const archive={appendObservation:async observation=>{
    actions.push('archive');
    assert.equal(observation.candles.length,2);
    assert.equal(observation.candles[0].volume,null);
  }};
  await collectOnce({provider,store,config,now:()=>7_200_100,archive,
    resolveArchiveMarket:()=>market});
  assert.deepEqual(actions,['archive','snapshot','events','state','status']);
});
test('archive failure stops collector before snapshot and state',async()=>{
  const {actions,provider,store}=setup();
  const archive={appendObservation:async()=>{actions.push('archive');throw new Error('archive unavailable');}};
  await assert.rejects(collectOnce({provider,store,config,now:()=>7_200_100,archive,
    resolveArchiveMarket:()=>market}),/archive unavailable/);
  assert.deepEqual(actions,['archive']);
});
test('archive cannot be enabled without explicit market resolver',async()=>{
  const {provider,store}=setup();
  await assert.rejects(collectOnce({provider,store,config,archive:{appendObservation:async()=>{}}}),
    /resolveArchiveMarket/);
});
