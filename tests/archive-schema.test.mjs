import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ArchiveSchemaError, validateMarketIdentity, createMarketId,
  validateArchiveCandle, createCandleKey, createCandleHash, createRecordHash,
} from '../monitor/archive-schema.mjs';

const market = Object.freeze({
  schemaVersion: 1, provider: 'bookflow', providerSymbol: 'BTC',
  providerTicker: 'BTC/USDT', displayName: 'BTC/USD',
  exchange: null, marketType: 'unknown', priceBasis: 'unknown',
  quoteAsset: 'USD', settlementToken: 'USD', resolution: '60',
});
const candle = Object.freeze({
  openTimeMs: 3_600_000, open: 100, high: 110, low: 90, close: 105, volume: null,
  snapshotTimeMs: 7_200_000, receivedAtMs: 7_200_100, knownAtMs: 7_200_100,
});
const rejects = (fn, code) => assert.throws(fn, err => err instanceof ArchiveSchemaError && err.code === code);

test('01: valid market identity is immutable', () => {
  assert.deepEqual(validateMarketIdentity(market), market);
  assert.ok(Object.isFrozen(validateMarketIdentity(market)));
});
test('02: provider changes market id', () => {
  assert.notEqual(createMarketId(market), createMarketId({...market, provider:'another-provider'}));
});
test('03: price basis changes market id', () => {
  assert.notEqual(createMarketId(market), createMarketId({...market, priceBasis:'index'}));
});
test('04: ticker and quote asset are distinct identity fields', () => {
  assert.notEqual(createMarketId(market), createMarketId({...market, quoteAsset:'USDT'}));
});
test('05: unknown identity fields are rejected', () => {
  rejects(() => validateMarketIdentity({...market, guessed:'spot'}), 'unknown_field');
});
test('06: candle validates on exact closing boundary', () => {
  assert.equal(validateArchiveCandle(candle,market).openTimeMs,3_600_000);
});
test('07: forming candle is rejected', () => {
  rejects(() => validateArchiveCandle({...candle,snapshotTimeMs:7_199_999},market),'unclosed_candle');
});
test('08: misaligned opening is rejected', () => {
  rejects(() => validateArchiveCandle({...candle,openTimeMs:3_600_001},market),'timestamp_alignment');
});
test('09: observation time cannot precede snapshot', () => {
  rejects(() => validateArchiveCandle({...candle,receivedAtMs:7_199_999},market),'observation_order');
});
test('10: known time cannot precede receipt', () => {
  rejects(() => validateArchiveCandle({...candle,knownAtMs:7_200_099},market),'observation_order');
});
test('11: invalid OHLC bounds are rejected', () => {
  rejects(() => validateArchiveCandle({...candle,high:104},market),'invalid_ohlc');
});
test('12: zero and negative prices are rejected', () => {
  rejects(() => validateArchiveCandle({...candle,open:0},market),'invalid_price');
  rejects(() => validateArchiveCandle({...candle,low:-1},market),'invalid_price');
});
test('13: missing volume remains null', () => {
  assert.equal(validateArchiveCandle(candle,market).volume,null);
});
test('14: invalid volume is rejected', () => {
  rejects(() => validateArchiveCandle({...candle,volume:-1},market),'invalid_volume');
  rejects(() => validateArchiveCandle({...candle,volume:NaN},market),'invalid_volume');
});
test('15: candle key depends on market and time', () => {
  assert.notEqual(createCandleKey(market,candle.openTimeMs),createCandleKey({...market,provider:'other'},candle.openTimeMs));
});
test('16: content hash ignores observation timestamps', () => {
  const later={...candle,receivedAtMs:7_201_000,knownAtMs:7_201_000};
  assert.equal(createCandleHash(candle,market),createCandleHash(later,market));
});
test('17: OHLCV changes content hash', () => {
  assert.notEqual(createCandleHash(candle,market),createCandleHash({...candle,close:106},market));
});
test('18: record hash changes with revision', () => {
  const r={candleKey:createCandleKey(market,candle.openTimeMs),revision:1,
    contentHash:createCandleHash(candle,market),knownAtMs:candle.knownAtMs,previousRevisionHash:null};
  assert.match(createRecordHash(r),/^[a-f0-9]{64}$/);
  assert.notEqual(createRecordHash(r),createRecordHash({...r,revision:2}));
});
