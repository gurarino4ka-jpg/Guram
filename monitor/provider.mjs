import { SUPPORTED_RESOLUTIONS, resolutionSeconds } from './core.mjs';

const ORIGIN = 'https://app.bookflow.sh';
const SYMBOLS = Object.freeze(['BTC', 'ETH', 'SOL', 'ZEC']);
const MAX_RETRY_AFTER_MS = 3_600_000;
const FIXED_SCALE = 1_000_000_000;

export class ProviderError extends Error {
  constructor(code, message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function fail(code, message, details) {
  throw new ProviderError(code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkSymbol(symbol) {
  if (typeof symbol !== 'string' || !SYMBOLS.includes(symbol)) {
    fail('invalid_symbols', 'Only BTC, ETH, SOL and ZEC are supported');
  }
}

function retryDelay(value, nowMs) {
  if (typeof value !== 'string' || value.length > 128 || value.trim() === '') return null;
  const trimmed = value.trim();
  let delay;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) delay = Number(trimmed) * 1000;
  else {
    const dateMs = Date.parse(trimmed);
    if (!Number.isFinite(dateMs)) return null;
    delay = dateMs - nowMs;
  }
  if (!Number.isFinite(delay)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, delay));
}

function scaledPrice(raw) {
  if ((typeof raw === 'string' && !/^\d+$/.test(raw))
    || (typeof raw === 'number' && !Number.isSafeInteger(raw))
    || (typeof raw !== 'string' && typeof raw !== 'number')) {
    fail('invalid_payload', 'A requested market has an invalid fixed-point index price');
  }
  const price = Number(raw) / FIXED_SCALE;
  if (!Number.isFinite(price) || price <= 0) fail('invalid_payload', 'A requested market has an invalid index price');
  return price;
}

/** Public data only: no account/session options, credentials, redirects or mutations. */
export function createBookflowProvider({ fetchImpl = globalThis.fetch, timeoutMs = 10_000, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    fail('invalid_config', 'Provider requires fetch, a clock and a timeout between 1 and 120000 ms');
  }

  function observationTime() {
    const value = now();
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail('invalid_config', 'Provider clock returned an invalid observation time');
    }
    return value;
  }

  async function readJson(sourceUrl) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError('request_timeout', 'Public market-data request timed out'));
      }, timeoutMs);
    });
    const request = async () => {
      const response = await fetchImpl(sourceUrl, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        fail('invalid_payload', 'Public market-data source returned an invalid HTTP response');
      }
      if (response.status < 200 || response.status >= 300) {
        const delay = response.status === 429
          ? retryDelay(response.headers?.get?.('retry-after'), observationTime()) : null;
        fail('http_error', 'Public market-data source returned an unsuccessful HTTP status', {
          status: response.status, retryAfterMs: delay,
        });
      }
      if (typeof response.json !== 'function') fail('invalid_payload', 'Public market-data response has no JSON reader');
      let payload;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) fail('request_timeout', 'Public market-data request timed out');
        fail('invalid_json', 'Public market-data source did not return valid JSON');
      }
      return { payload, receivedAtMs: observationTime(), sourceUrl };
    };
    try {
      return await Promise.race([request(), timeout]);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted) fail('request_timeout', 'Public market-data request timed out');
      // Never copy raw response bodies, request headers or transport messages into logs.
      fail('network_error', 'Unable to read public Bookflow market data');
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchQuotes(symbols) {
    if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > SYMBOLS.length
      || new Set(symbols).size !== symbols.length) {
      fail('invalid_symbols', 'Quote symbols must be a nonempty unique list of the four supported assets');
    }
    symbols.forEach(checkSymbol);
    observationTime();
    const { payload, receivedAtMs, sourceUrl } = await readJson(new URL('/api/v2/markets', ORIGIN).toString());
    if (!Array.isArray(payload)) fail('invalid_payload', 'Market list must be an array');
    const quotes = symbols.map(symbol => {
      const matches = payload.filter(market => market?.config?.baseAsset === symbol);
      if (matches.length === 0) fail('missing_market', 'A requested market is missing from the source response');
      if (matches.length !== 1) fail('invalid_payload', 'A requested market is ambiguous in the source response');
      const market = matches[0];
      if (!isObject(market) || !isObject(market.config) || !isObject(market.state)
        || market.config.ticker !== `${symbol}/USDT` || market.config.name !== `${symbol}/USD`
        || market.config.quoteAsset !== 'USD' || market.config.settlementToken !== 'USD') {
        fail('invalid_payload', 'Requested market metadata no longer matches its known USD-settled contract');
      }
      const timeMs = market.state.blockTimestamp;
      if (typeof timeMs !== 'number' || !Number.isFinite(timeMs) || timeMs < 0 || timeMs > receivedAtMs + 10_000) {
        fail('invalid_payload', 'A requested market has an invalid or future quote timestamp');
      }
      return {
        symbol, ticker: market.config.ticker, displayName: market.config.name,
        settlementCurrency: market.config.settlementToken, price: scaledPrice(market.state.indexPrice), timeMs,
      };
    });
    return { quotes, receivedAtMs, sourceUrl };
  }

  async function fetchHistory(symbol, resolution, { countback = 300 } = {}) {
    checkSymbol(symbol);
    const normalizedResolution = String(resolution);
    if (!SUPPORTED_RESOLUTIONS.includes(normalizedResolution) || !Number.isInteger(countback) || countback < 1 || countback > 500) {
      fail('invalid_history_request', 'History requires a supported resolution and countback from 1 to 500');
    }
    const snapshotTimeMs = observationTime();
    const to = Math.floor(snapshotTimeMs / 1000);
    const from = Math.max(0, to - countback * resolutionSeconds(normalizedResolution));
    const url = new URL('/api/datafeed-api/history', ORIGIN);
    url.search = new URLSearchParams({ symbol, resolution: normalizedResolution, from: String(from), to: String(to), countback: String(countback) }).toString();
    const result = await readJson(url.toString());
    if (!isObject(result.payload) || !['ok', 'no_data'].includes(result.payload.s)) {
      fail('invalid_payload', 'History source returned an unexpected JSON shape');
    }
    if (result.payload.s === 'ok' && (['t', 'o', 'h', 'l', 'c'].some(field => !Array.isArray(result.payload[field]))
      || (result.payload.v !== undefined && !Array.isArray(result.payload.v)))) {
      fail('invalid_payload', 'History source returned invalid timestamp or OHLC arrays');
    }
    // Use request-start time for close eligibility: a candle fetched just before
    // its boundary must not become "final" merely because its response was slow.
    return { ...result, snapshotTimeMs };
  }

  return { fetchQuotes, fetchHistory };
}
