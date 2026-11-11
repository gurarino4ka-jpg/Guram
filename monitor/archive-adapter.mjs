import { validateMarketIdentity, validateArchiveCandle } from './archive-schema.mjs';

/**
 * Build a CA-02 observation from a validated UDF response.
 * Identity is deliberately explicit: quote metadata must not be inferred from a ticker.
 * This adapter does not perform I/O or send orders.
 */
export function buildArchiveObservation({ market, validation, receivedAtMs, snapshotTimeMs } = {}) {
  const identity = validateMarketIdentity(market);
  if (!validation || !Array.isArray(validation.closedCandles) ||
      validation.resolution !== identity.resolution ||
      !Number.isSafeInteger(validation.periodSeconds) || validation.periodSeconds < 1) {
    throw new TypeError('Validated closed candles and matching resolution are required.');
  }
  if (!Number.isSafeInteger(receivedAtMs) || !Number.isSafeInteger(snapshotTimeMs) ||
      snapshotTimeMs < 0 || receivedAtMs < snapshotTimeMs) {
    throw new TypeError('Invalid observation times.');
  }
  const candles = validation.closedCandles.map(item => {
    if (!Number.isSafeInteger(item.time) || item.time < 0) throw new TypeError('Invalid UDF timestamp.');
    const candidate = {
      openTimeMs: item.time * 1000,
      open: item.open, high: item.high, low: item.low, close: item.close, volume: item.volume,
      snapshotTimeMs, receivedAtMs, knownAtMs: receivedAtMs,
    };
    validateArchiveCandle(candidate, identity);
    return candidate;
  });
  return { market: identity, candles };
}
