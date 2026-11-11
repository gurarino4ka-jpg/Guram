import { createCandleArchive } from '../monitor/archive-store.mjs';

const dir=process.argv[2];
if (!dir) throw new Error('Missing test directory');
const market={
  schemaVersion:1,provider:'synthetic',providerSymbol:'CRASH',providerTicker:null,
  displayName:null,exchange:null,marketType:'unknown',priceBasis:'unknown',
  quoteAsset:null,settlementToken:null,resolution:'60',
};
const candle={
  openTimeMs:3_600_000,open:100,high:110,low:90,close:105,volume:null,
  snapshotTimeMs:7_200_000,receivedAtMs:7_200_100,knownAtMs:7_200_100,
};
const archive=await createCandleArchive(dir);
await archive.open();
await archive.appendObservation({market,candles:[candle]});
if (!process.send) throw new Error('IPC is required');
process.send({ready:true});
setInterval(()=>{},1000);
