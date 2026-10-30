import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOnce } from '../monitor/collector.mjs';
import { validateConfig } from '../monitor/config.mjs';

const config = { mode: 'data-only', symbols: ['BTC'], resolutions: ['60'], pollSeconds: 60, countback: 300, timeoutSeconds: 10, maxQuoteAgeSeconds: 120, maxClosedLagPeriods: 1, dataDir: 'unused' };
const hour = 3_600_000;
function history(times) {
  return { s: 'ok', t: times, o: times.map(() => 100), h: times.map(() => 102), l: times.map(() => 99), c: times.map(() => 101), v: times.map(() => 10) };
}
function fakeStore(overrides = {}) {
  const events = [], snapshots = [], checkpoints = [], statuses = [];
  return {
    events, snapshots, checkpoints, statuses,
    async writeSnapshot(...args) { snapshots.push(args); },
    async appendEvents(items) { let added = 0; for (const item of items) if (!events.some(event => event.id === item.id)) { events.push(structuredClone(item)); added++; } return added; },
    async writeState(state) { checkpoints.push(structuredClone(state)); },
    async writeStatus(status) { statuses.push(structuredClone(status)); },
    ...overrides,
  };
}
function fakeProvider({ receivedAtMs = 3 * hour + 60_000, times = [3600, 7200, 10800], quoteTimeMs = receivedAtMs, error } = {}) {
  return {
    async fetchQuotes(symbols) { return { quotes: symbols.map(symbol => ({ symbol, price: 101, timeMs: quoteTimeMs })), receivedAtMs }; },
    async fetchHistory() { if (error) throw error; return { payload: history(times), receivedAtMs, sourceUrl: 'https://app.bookflow.sh/api/datafeed-api/history' }; },
  };
}

test('warmup excludes forming bar and does not invent historical live events', async () => {
  const store = fakeStore();
  const result = await collectOnce({ provider: fakeProvider(), store, config, now: () => 3 * hour + 60_000 });
  assert.equal(result.status.health, 'ok');
  assert.equal(result.status.executionEnabled, false);
  assert.equal(result.state.streams['BTC:60'].lastClosedTime, 7200);
  assert.equal(store.events.filter(event => event.type === 'candle_closed').length, 0);
  assert.equal(store.events.find(event => event.type === 'warmup').candleCount, 2);
  assert.equal(store.snapshots[0][2].formingCandles[0].time, 10800);
});

test('saved checkpoint logs a newly closed bar only once across repeated cycles', async () => {
  const store = fakeStore();
  const initial = await collectOnce({ provider: fakeProvider(), store, config, now: () => 3 * hour + 60_000 });
  const later = fakeProvider({ receivedAtMs: 4 * hour + 60_000, times: [7200, 10800, 14400] });
  const second = await collectOnce({ provider: later, store, config, previousState: initial.state, now: () => 4 * hour + 60_000 });
  const third = await collectOnce({ provider: later, store, config, previousState: second.state, now: () => 4 * hour + 60_000 });
  assert.deepEqual(store.events.filter(event => event.type === 'candle_closed').map(event => event.id), ['BTC:60:10800']);
  assert.equal(third.status.appendedEvents, 0);
  assert.equal(third.state.streams['BTC:60'].lastClosedTime, 10800);
});

test('a response crossing the close boundary cannot finalize a pre-close candle', async () => {
  const store = fakeStore();
  const provider = fakeProvider({ receivedAtMs: 4 * hour + 1000, times: [7200, 10800] });
  const fetch = provider.fetchHistory;
  provider.fetchHistory = async (...args) => ({ ...await fetch(...args), snapshotTimeMs: 4 * hour - 1000 });
  const result = await collectOnce({ provider, store, config, now: () => 4 * hour + 1000 });
  assert.equal(result.state.streams['BTC:60'].lastClosedTime, 7200);
  assert.equal(store.snapshots[0][2].formingCandles[0].time, 10800);
});

test('stale quotes and missing closed candles mark health degraded', async () => {
  const store = fakeStore();
  const result = await collectOnce({ provider: fakeProvider({ receivedAtMs: 6 * hour, quoteTimeMs: 3 * hour }), store, config, now: () => 6 * hour });
  assert.equal(result.status.health, 'degraded');
  assert.ok(result.status.issues.some(issue => issue.code === 'stale_quote'));
  assert.ok(result.status.issues.some(issue => issue.code === 'stale_candles'));
});

test('source failure preserves the last checkpoint and is not reported as healthy', async () => {
  const previousState = { version: 1, streams: { 'BTC:60': { symbol: 'BTC', resolution: '60', lastClosedTime: 7200 } }, healthSignature: null };
  const store = fakeStore();
  const result = await collectOnce({ provider: fakeProvider({ error: Object.assign(new Error('unavailable'), { code: 'network_error' }) }), store, config, previousState });
  assert.equal(result.status.health, 'degraded');
  assert.equal(result.state.streams['BTC:60'].lastClosedTime, 7200);
  assert.equal(result.status.completedStreams, 0);
  assert.ok(result.status.issues.some(issue => issue.code === 'network_error'));
});

test('429 from quotes pauses subsequent history requests and returns retry delay', async () => {
  let histories = 0;
  const provider = { async fetchQuotes() { throw Object.assign(new Error('rate limited'), { code: 'http_error', status: 429, retryAfterMs: 60_000 }); }, async fetchHistory() { histories++; } };
  const result = await collectOnce({ provider, store: fakeStore(), config });
  assert.equal(histories, 0);
  assert.equal(result.retryAfterMs, 60_000);
  assert.equal(result.status.health, 'degraded');
});

test('disk failure stops collection before saving a new checkpoint', async () => {
  const store = fakeStore({ async writeSnapshot() { throw new Error('disk failure'); } });
  await assert.rejects(collectOnce({ provider: fakeProvider(), store, config }), /disk failure/);
  assert.equal(store.checkpoints.length, 0);
  assert.equal(store.events.length, 0);
});

test('configuration rejects execution mode, unsupported symbols and aggressive polling', () => {
  assert.equal(validateConfig(config).mode, 'data-only');
  for (const update of [{ mode: 'trade' }, { symbols: ['DOGE'] }, { symbols: ['BTC', 'BTC'] }, { pollSeconds: 1 }, { arbitraryEndpoint: 'https://elsewhere.invalid' }]) {
    assert.throws(() => validateConfig({ ...config, ...update }));
  }
});
