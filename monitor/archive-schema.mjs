import { createHash } from 'node:crypto';
import { resolutionSeconds, SUPPORTED_RESOLUTIONS } from './core.mjs';

/**
 * CA-01: deterministic, read-only candle schema.
 * No market requests, filesystem writes or trading operations.
 */
export class ArchiveSchemaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveSchemaError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ArchiveSchemaError(code, message);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keysExactly(value, required, optional = []) {
  if (!record(value)) fail('invalid_record', 'Expected an object.');
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some(key => !allowed.has(key))) fail('unknown_field', 'Unexpected field in schema.');
  if (required.some(key => !Object.hasOwn(value, key))) fail('missing_field', 'Required field is missing.');
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() ||
      value.length > 160 || /[\x00-\x1f\x7f]/.test(value)) {
    fail('invalid_identity', 'Invalid ' + name + '.');
  }
  return value;
}

function nullableString(value, name) {
  return value === null ? null : requiredString(value, name);
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid_timestamp', 'Invalid ' + name + '.');
  return value;
}

function price(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail('invalid_price', 'Invalid ' + name + '.');
  }
  return value;
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_number', 'Nonfinite number cannot be hashed.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (!record(value)) fail('invalid_value', 'Unsupported value in canonical record.');
  const names = Object.keys(value).sort();
  return '{' + names.map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

function digest(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

export function validateMarketIdentity(input) {
  const fields = ['schemaVersion', 'provider', 'providerSymbol', 'providerTicker', 'displayName',
    'exchange', 'marketType', 'priceBasis', 'quoteAsset', 'settlementToken', 'resolution'];
  keysExactly(input, fields);
  if (input.schemaVersion !== 1) fail('unsupported_schema', 'Market identity schema must be version 1.');
  const resolution = String(input.resolution);
  if (!SUPPORTED_RESOLUTIONS.includes(resolution) || input.resolution !== resolution) {
    fail('invalid_resolution', 'Resolution must use a supported canonical string.');
  }
  return Object.freeze({
    schemaVersion: 1,
    provider: requiredString(input.provider, 'provider'),
    providerSymbol: requiredString(input.providerSymbol, 'providerSymbol'),
    providerTicker: nullableString(input.providerTicker, 'providerTicker'),
    displayName: nullableString(input.displayName, 'displayName'),
    exchange: nullableString(input.exchange, 'exchange'),
    marketType: requiredString(input.marketType, 'marketType'),
    priceBasis: requiredString(input.priceBasis, 'priceBasis'),
    quoteAsset: nullableString(input.quoteAsset, 'quoteAsset'),
    settlementToken: nullableString(input.settlementToken, 'settlementToken'),
    resolution,
  });
}

export function createMarketId(identity) {
  return 'market-v1-' + digest(validateMarketIdentity(identity));
}

export function validateArchiveCandle(input, identity) {
  const market = validateMarketIdentity(identity);
  keysExactly(input, ['openTimeMs', 'open', 'high', 'low', 'close', 'volume',
    'snapshotTimeMs', 'receivedAtMs', 'knownAtMs']);
  const periodMs = resolutionSeconds(market.resolution) * 1000;
  const openTimeMs = timestamp(input.openTimeMs, 'openTimeMs');
  const snapshotTimeMs = timestamp(input.snapshotTimeMs, 'snapshotTimeMs');
  const receivedAtMs = timestamp(input.receivedAtMs, 'receivedAtMs');
  const knownAtMs = timestamp(input.knownAtMs, 'knownAtMs');
  if (openTimeMs % periodMs !== 0) fail('timestamp_alignment', 'Candle open time is not aligned.');
  if (!Number.isSafeInteger(openTimeMs + periodMs) || openTimeMs + periodMs > snapshotTimeMs) {
    fail('unclosed_candle', 'Candle was not closed at snapshot time.');
  }
  if (snapshotTimeMs > receivedAtMs || receivedAtMs > knownAtMs) {
    fail('observation_order', 'Observation time order is invalid.');
  }
  const open = price(input.open, 'open');
  const high = price(input.high, 'high');
  const low = price(input.low, 'low');
  const close = price(input.close, 'close');
  if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
    fail('invalid_ohlc', 'OHLC bounds are inconsistent.');
  }
  const volume = input.volume;
  if (volume !== null && (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0)) {
    fail('invalid_volume', 'Volume must be null or a finite nonnegative number.');
  }
  return Object.freeze({
    marketId: createMarketId(market), resolution: market.resolution, openTimeMs,
    periodMs, open, high, low, close, volume, snapshotTimeMs, receivedAtMs, knownAtMs,
  });
}

export function createCandleKey(identity, openTimeMs) {
  const market = validateMarketIdentity(identity);
  const periodMs = resolutionSeconds(market.resolution) * 1000;
  timestamp(openTimeMs, 'openTimeMs');
  if (openTimeMs % periodMs !== 0) fail('timestamp_alignment', 'Candle open time is not aligned.');
  return createMarketId(market) + ':' + openTimeMs;
}

export function createCandleHash(candle, identity) {
  const checked = validateArchiveCandle(candle, identity);
  return digest({
    marketId: checked.marketId, resolution: checked.resolution, openTimeMs: checked.openTimeMs,
    open: checked.open, high: checked.high, low: checked.low, close: checked.close, volume: checked.volume,
  });
}

export function createRecordHash(record) {
  if (!record || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      typeof record.candleKey !== 'string' || !record.candleKey ||
      typeof record.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.contentHash) ||
      !Number.isSafeInteger(record.knownAtMs) || record.knownAtMs < 0 ||
      (record.previousRevisionHash !== null && (typeof record.previousRevisionHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.previousRevisionHash)))) {
    fail('invalid_revision', 'Invalid revision record.');
  }
  return digest({
    schemaVersion: 1, candleKey: record.candleKey, revision: record.revision,
    contentHash: record.contentHash, knownAtMs: record.knownAtMs,
    previousRevisionHash: record.previousRevisionHash,
  });
}
