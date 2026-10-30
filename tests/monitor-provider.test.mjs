import test from 'node:test';
import assert from 'node:assert/strict';
import { createBookflowProvider, ProviderError } from '../monitor/provider.mjs';

const NOW = Date.parse('2026-10-30T07:01:13.900Z');
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'ZEC'];
const hasCode = code => error => error instanceof ProviderError && error.code === code;
function market(symbol, raw = '12345000000000', timeMs = NOW - 500) {
  return {
    config: { baseAsset: symbol, ticker: `${symbol}/USDT`, name: `${symbol}/USD`, quoteAsset: 'USD', settlementToken: 'USD' },
    state: { indexPrice: raw, blockTimestamp: timeMs },
  };
}
const jsonResponse = (payload, options = {}) => new Response(JSON.stringify(payload), { status: 200, ...options });
const udf = { s: 'ok', t: [1793343600], o: [100], h: [110], l: [90], c: [105], v: [1] };

test('quote requests use the hardcoded public origin, GET and no credentials, then scale fixed-point USD prices', async () => {
  const calls = [];
  const provider = createBookflowProvider({ now: () => NOW, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return jsonResponse([market('BTC', '78479344813499'), market('ETH', '2248164570897'), market('SOL', '98060351397'), market('ZEC', '1275326223862')]);
  } });
  const result = await provider.fetchQuotes(SYMBOLS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://app.bookflow.sh/api/v2/markets');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(calls[0].options.headers, { accept: 'application/json' });
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(result.quotes.map(quote => quote.symbol), SYMBOLS);
  assert.equal(result.quotes[0].price, 78479.344813499);
  assert.equal(result.quotes[1].price, 2248.164570897);
  assert.equal(result.quotes[2].displayName, 'SOL/USD');
  assert.equal(result.quotes[3].settlementCurrency, 'USD');
  assert.equal(result.receivedAtMs, NOW);
});

test('history query uses base symbols, bounded countback and Unix seconds without inventing an auth channel', async () => {
  let called;
  const provider = createBookflowProvider({ now: () => NOW, fetchImpl: async (url, options) => {
    called = { url: new URL(url), options };
    return jsonResponse(udf);
  } });
  const result = await provider.fetchHistory('BTC', '60', { countback: 10 });
  assert.equal(called.url.origin, 'https://app.bookflow.sh');
  assert.equal(called.url.pathname, '/api/datafeed-api/history');
  assert.deepEqual(Object.fromEntries(called.url.searchParams), {
    symbol: 'BTC', resolution: '60', from: '1793307673', to: '1793343673', countback: '10',
  });
  assert.equal(called.options.method, 'GET');
  assert.equal(called.options.credentials, 'omit');
  assert.equal(result.snapshotTimeMs, NOW);
  assert.equal(result.receivedAtMs, NOW);
  assert.deepEqual(result.payload, udf);
});

test('history snapshot time stays at request start if response crosses a close boundary', async () => {
  const beforeClose = Date.parse('2026-10-30T06:59:59.900Z');
  const afterClose = beforeClose + 500;
  let clock = beforeClose;
  const provider = createBookflowProvider({ now: () => clock, fetchImpl: async () => {
    clock = afterClose;
    return jsonResponse(udf);
  } });
  const result = await provider.fetchHistory('ETH', '60');
  assert.equal(result.snapshotTimeMs, beforeClose);
  assert.equal(result.receivedAtMs, afterClose);
});

test('daily history uses a daily duration and empty history is a valid source response', async () => {
  let url;
  const provider = createBookflowProvider({ now: () => NOW, fetchImpl: async value => {
    url = new URL(value);
    return jsonResponse({ s: 'no_data' });
  } });
  assert.deepEqual((await provider.fetchHistory('ZEC', '1D', { countback: 2 })).payload, { s: 'no_data' });
  assert.equal(Number(url.searchParams.get('to')) - Number(url.searchParams.get('from')), 172800);
});

test('unsupported symbols, resolutions and countback cannot result in a network call', async () => {
  let calls = 0;
  const provider = createBookflowProvider({ now: () => NOW, fetchImpl: async () => { calls++; return jsonResponse([]); } });
  for (const symbols of [[], ['BTC', 'BTC'], ['DOGE'], ['BTC/USD'], 'BTC']) {
    await assert.rejects(provider.fetchQuotes(symbols), hasCode('invalid_symbols'));
  }
  await assert.rejects(provider.fetchHistory('BTC/USDT', '60'), hasCode('invalid_symbols'));
  await assert.rejects(provider.fetchHistory('BTC', '3'), hasCode('invalid_history_request'));
  for (const countback of [0, 501, 1.5, '300']) {
    await assert.rejects(provider.fetchHistory('BTC', '60', { countback }), hasCode('invalid_history_request'));
  }
  assert.equal(calls, 0);
});

test('missing, duplicate and remapped requested markets cannot masquerade as quotes', async () => {
  for (const [payload, code] of [
    [[market('ETH')], 'missing_market'],
    [[market('BTC'), market('BTC')], 'invalid_payload'],
    [[{ ...market('BTC'), config: { ...market('BTC').config, settlementToken: 'USDT' } }], 'invalid_payload'],
    [{ data: [market('BTC')] }, 'invalid_payload'],
  ]) {
    const provider = createBookflowProvider({ now: () => NOW, fetchImpl: async () => jsonResponse(payload) });
    await assert.rejects(provider.fetchQuotes(['BTC']), hasCode(code));
  }
});

test('quotes reject invalid prices and timestamps but leave old-quote age decisions to the caller', async () => {
  for (const raw of ['-1', '0', 'NaN', '1e12', 0, NaN, null]) {
    const provider = createBookflowProvider({ now: () => NOW, fetchImpl: async () => jsonResponse([market('BTC', raw)]) });
    await assert.rejects(provider.fetchQuotes(['BTC']), hasCode('invalid_payload'));
  }
  for (const time of [NOW + 10001, '1793343673900', -1, null]) {
    const provider = createBookflowProvider({ now: () => NOW, fetchImpl: async () => jsonResponse([market('BTC', '1000000000', time)]) });
    await assert.rejects(provider.fetchQuotes(['BTC']), hasCode('invalid_payload'));
  }
  const old = createBookflowProvider({ now: () => NOW, fetchImpl: async () => jsonResponse([market('BTC', '1000000000', 0)]) });
  assert.equal((await old.fetchQuotes(['BTC'])).quotes[0].timeMs, 0);
});

test('HTTP failures carry status without reading or exposing error response bodies', async () => {
  for (const status of [401, 403, 500]) {
    let bodyRead = false;
    const provider = createBookflowProvider({ now: () => NOW, fetchImpl: async () => ({
      status, headers: new Headers(), json: async () => { bodyRead = true; throw new Error('private-response-detail'); },
    }) });
    await assert.rejects(provider.fetchQuotes(['BTC']), error => {
      assert.equal(error.code, 'http_error');
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, null);
      assert.doesNotMatch(error.message, /private-response-detail/);
      return true;
    });
    assert.equal(bodyRead, false);
  }
});

test('429 Retry-After supports seconds/date, bounds delays to an hour and performs no automatic retry', async () => {
  for (const [header, expected] of [
    ['120', 120000], ['86400', 3600000],
    [new Date(NOW + 30000).toUTCString(), 29100],
    [new Date(NOW - 60000).toUTCString(), 0],
    ['not-a-date', null],
  ]) {
    let calls = 0;
    const provider = createBookflowProvider({ now: () => NOW, fetchImpl: async () => {
      calls++;
      return jsonResponse({ ignored: 'never-read' }, { status: 429, headers: { 'Retry-After': header } });
    } });
    await assert.rejects(provider.fetchHistory('BTC', '60'), error => {
      assert.equal(error.code, 'http_error');
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, expected);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('timeout aborts the request even when an injected transport never settles', async () => {
  let signal;
  const provider = createBookflowProvider({ now: () => NOW, timeoutMs: 10, fetchImpl: (url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  await assert.rejects(provider.fetchHistory('SOL', '30'), hasCode('request_timeout'));
  assert.equal(signal.aborted, true);
});

test('network/JSON failures become sanitized errors and unexpected UDF shapes are rejected', async () => {
  const broken = createBookflowProvider({ now: () => NOW, fetchImpl: async () => { throw new Error('transport-secret'); } });
  await assert.rejects(broken.fetchQuotes(['BTC']), error => {
    assert.equal(error.code, 'network_error');
    assert.doesNotMatch(error.message, /transport-secret/);
    return true;
  });
  const notJson = createBookflowProvider({ now: () => NOW, fetchImpl: async () => new Response('not-json') });
  await assert.rejects(notJson.fetchHistory('BTC', '60'), hasCode('invalid_json'));
  for (const payload of [null, [], { s: 'error' }, { s: 'ok', t: [] }, { ...udf, v: 'wrong' }]) {
    const provider = createBookflowProvider({ now: () => NOW, fetchImpl: async () => jsonResponse(payload) });
    await assert.rejects(provider.fetchHistory('BTC', '60'), hasCode('invalid_payload'));
  }
});

test('invalid provider options and a broken clock fail before requests', async () => {
  for (const options of [{ fetchImpl: null }, { now: null }, { timeoutMs: 0 }, { timeoutMs: 120001 }]) {
    assert.throws(() => createBookflowProvider(options), hasCode('invalid_config'));
  }
  let called = false;
  const provider = createBookflowProvider({ now: () => NaN, fetchImpl: async () => { called = true; } });
  await assert.rejects(provider.fetchHistory('BTC', '60'), hasCode('invalid_config'));
  assert.equal(called, false);
});
