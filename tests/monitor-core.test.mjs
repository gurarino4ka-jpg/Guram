import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketDataError, resolutionSeconds, validateUdfHistory, planClosedCandleUpdate } from '../monitor/core.mjs';

const HOUR = 3_600;
const options = (nowSeconds, extra = {}) => ({ resolution: '60', nowMs: nowSeconds * 1000, ...extra });
function history(times, extra = {}) {
  return {
    s: 'ok', t: times, o: times.map(() => 100), h: times.map(() => 110),
    l: times.map(() => 90), c: times.map(() => 105), v: times.map(() => 12.5), ...extra,
  };
}
const stream = { symbol: 'BTC', resolution: '60' };
const hasCode = code => error => error instanceof MarketDataError && error.code === code;

test('only fully closed candles are eligible, including the exact close boundary', () => {
  const input = history([0, HOUR, 2 * HOUR]);
  const before = validateUdfHistory(input, options(3 * HOUR - 0.001));
  assert.deepEqual(before.closedCandles.map(c => c.time), [0, HOUR]);
  assert.deepEqual(before.formingCandles.map(c => c.time), [2 * HOUR]);
  const exact = validateUdfHistory(input, options(3 * HOUR));
  assert.equal(exact.closedCandles.length, 3);
  assert.equal(exact.formingCandles.length, 0);
  assert.deepEqual(input, history([0, HOUR, 2 * HOUR]), 'input arrays are not mutated');
});

test('source errors, missing/mismatched arrays and numeric strings are rejected', () => {
  assert.throws(() => validateUdfHistory({ s: 'error', errmsg: 'private detail' }, options(HOUR)), hasCode('source_error'));
  assert.throws(() => validateUdfHistory({ s: 'ok' }, options(HOUR)), hasCode('missing_array'));
  assert.throws(() => validateUdfHistory(history([0], { h: [] }), options(HOUR)), hasCode('array_length_mismatch'));
  assert.throws(() => validateUdfHistory(history([0], { v: [] }), options(HOUR)), hasCode('array_length_mismatch'));
  for (const price of [NaN, Infinity, 0, -1, '100']) {
    assert.throws(() => validateUdfHistory(history([0], { o: [price] }), options(HOUR)), hasCode('invalid_price'));
  }
  assert.throws(() => validateUdfHistory(history([0], { v: [-1] }), options(HOUR)), hasCode('invalid_volume'));
});

test('invalid OHLC and duplicate, reversed, misaligned or future times fail validation', () => {
  assert.throws(() => validateUdfHistory(history([0], { h: [99] }), options(HOUR)), hasCode('invalid_ohlc'));
  assert.throws(() => validateUdfHistory(history([0], { l: [106] }), options(HOUR)), hasCode('invalid_ohlc'));
  for (const times of [[0, 0], [HOUR, 0]]) {
    assert.throws(() => validateUdfHistory(history(times), options(3 * HOUR)), hasCode('timestamp_order'));
  }
  assert.throws(() => validateUdfHistory(history([1]), options(HOUR)), hasCode('timestamp_alignment'));
  assert.throws(() => validateUdfHistory(history([2 * HOUR]), options(HOUR)), hasCode('future_timestamp'));
  assert.throws(() => validateUdfHistory(history([-HOUR]), options(HOUR)), hasCode('invalid_timestamp'));
});

test('gaps are reported without fabricated candles; volume is optional', () => {
  const input = history([0, HOUR, 3 * HOUR]);
  delete input.v;
  const parsed = validateUdfHistory(input, options(4 * HOUR));
  assert.deepEqual(parsed.gaps, [{ afterTime: HOUR, beforeTime: 3 * HOUR, missingBars: 1 }]);
  assert.equal(parsed.closedCandles.length, 3);
  assert.equal(parsed.closedCandles[0].volume, null);
});

test('staleness is measured from the last completed close; no data cannot look fresh', () => {
  const atLimit = validateUdfHistory(history([0]), options(3 * HOUR));
  assert.equal(atLimit.stale, false);
  assert.equal(atLimit.closedLagMs, 2 * HOUR * 1000);
  assert.equal(validateUdfHistory(history([0]), options(3 * HOUR + 1)).stale, true);
  assert.equal(validateUdfHistory(history([0]), options(0)).stale, true, 'forming-only response has no completed candle');
  for (const payload of [{ s: 'no_data' }, history([])]) {
    const parsed = validateUdfHistory(payload, options(4 * HOUR));
    assert.equal(parsed.stale, true);
    assert.equal(parsed.latestClosedTime, null);
    assert.deepEqual(parsed.closedCandles, []);
  }
});

test('resolution and caller clock/staleness options must be explicitly valid', () => {
  assert.equal(resolutionSeconds('1D'), 86_400);
  assert.equal(resolutionSeconds('15'), 900);
  assert.equal(resolutionSeconds(30), 1_800);
  assert.throws(() => resolutionSeconds('3'), hasCode('unsupported_resolution'));
  assert.throws(() => validateUdfHistory(history([]), options(NaN)), hasCode('invalid_observation_time'));
  assert.throws(() => validateUdfHistory(history([]), options(HOUR, { maxClosedLagPeriods: -1 })), hasCode('invalid_staleness_limit'));
});

test('warmup establishes a baseline and restart emits each subsequent closed bar only once', () => {
  const baseline = validateUdfHistory(history([0, HOUR, 2 * HOUR]), options(2 * HOUR + 1));
  const warmup = planClosedCandleUpdate(null, baseline, stream);
  assert.equal(warmup.mode, 'warmup');
  assert.equal(warmup.warmupCandles, 2);
  assert.deepEqual(warmup.newCandles, []);
  assert.deepEqual(warmup.nextState, { ...stream, lastClosedTime: HOUR });
  const checkpoint = JSON.parse(JSON.stringify(warmup.nextState));
  const next = validateUdfHistory(history([0, HOUR, 2 * HOUR, 3 * HOUR]), options(3 * HOUR + 1));
  const update = planClosedCandleUpdate(checkpoint, next, stream);
  assert.deepEqual(update.newCandles.map(c => c.time), [2 * HOUR]);
  assert.deepEqual(update.eventIds, [`BTC:60:${2 * HOUR}`]);
  assert.deepEqual(checkpoint, warmup.nextState, 'saved input state is unchanged');
  const restarted = planClosedCandleUpdate(JSON.parse(JSON.stringify(update.nextState)), next, stream);
  assert.deepEqual(restarted.newCandles, []);
  assert.deepEqual(restarted.eventIds, []);
});

test('empty responses keep checkpoints, while history regression and mismatched streams are rejected', () => {
  const previous = { ...stream, lastClosedTime: 4 * HOUR };
  const empty = validateUdfHistory({ s: 'no_data' }, options(5 * HOUR));
  assert.deepEqual(planClosedCandleUpdate(previous, empty, stream).nextState, previous);
  const old = validateUdfHistory(history([0, HOUR]), options(5 * HOUR));
  assert.throws(() => planClosedCandleUpdate(previous, old, stream), hasCode('history_regression'));
  assert.throws(() => planClosedCandleUpdate({ ...previous, symbol: 'ETH' }, old, stream), hasCode('invalid_previous_state'));
  assert.throws(() => planClosedCandleUpdate({ ...previous, lastClosedTime: 1 }, old, stream), hasCode('invalid_previous_state'));
});

test('recovery detects history missing since the checkpoint and uses stable event IDs', () => {
  const previous = { ...stream, lastClosedTime: 0 };
  const parsed = validateUdfHistory(history([3 * HOUR, 4 * HOUR]), options(5 * HOUR));
  const update = planClosedCandleUpdate(previous, parsed, stream);
  assert.deepEqual(update.recoveryGap, { afterTime: 0, beforeTime: 3 * HOUR, missingBars: 2 });
  assert.deepEqual(update.eventIds, [`BTC:60:${3 * HOUR}`, `BTC:60:${4 * HOUR}`]);
  const retriedAfterJournalWrite = planClosedCandleUpdate(previous, parsed, stream);
  assert.deepEqual(retriedAfterJournalWrite.eventIds, update.eventIds, 'caller can de-duplicate crash recovery by event ID');
});
