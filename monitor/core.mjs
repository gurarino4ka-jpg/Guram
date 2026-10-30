/** Pure, read-only market-data validation. It deliberately produces no trade signals. */
export const SUPPORTED_RESOLUTIONS = Object.freeze(['15', '30', '60', '240', '1D']);

export class MarketDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarketDataError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MarketDataError(code, message);
}

export function resolutionSeconds(resolution) {
  const value = String(resolution);
  if (!SUPPORTED_RESOLUTIONS.includes(value)) fail('unsupported_resolution', `Unsupported resolution: ${value}`);
  return value === '1D' ? 86_400 : Number(value) * 60;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Parse a TradingView UDF history response whose timestamps are Unix seconds.
 * Prices are left unchanged: the Bookflow history endpoint already returns USD.
 * `nowMs` must be an explicit observation time, so callers/tests never depend on
 * a hidden clock. No missing bars are interpolated or treated as a flat candle.
 */
export function validateUdfHistory(payload, { resolution, nowMs, maxClosedLagPeriods = 2 } = {}) {
  const periodSeconds = resolutionSeconds(resolution);
  const periodMs = periodSeconds * 1000;
  if (!finiteNumber(nowMs) || nowMs < 0) fail('invalid_observation_time', 'nowMs must be a nonnegative finite number');
  if (!Number.isInteger(maxClosedLagPeriods) || maxClosedLagPeriods < 0 || maxClosedLagPeriods > 100) {
    fail('invalid_staleness_limit', 'maxClosedLagPeriods must be an integer from 0 to 100');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('invalid_payload', 'History must be an object');
  if (payload.s !== 'ok' && payload.s !== 'no_data') fail('source_error', 'History source did not return ok or no_data');

  const closedCandles = [];
  const formingCandles = [];
  const gaps = [];
  const staleAfterMs = maxClosedLagPeriods * periodMs;
  if (payload.s === 'no_data') {
    return {
      status: 'no_data', resolution: String(resolution), periodSeconds, closedCandles, formingCandles, gaps,
      latestClosedTime: null, latestClosedAtMs: null, closedLagMs: null, stale: true, staleAfterMs,
    };
  }

  for (const field of ['t', 'o', 'h', 'l', 'c']) {
    if (!Array.isArray(payload[field])) fail('missing_array', `History field ${field} must be an array`);
  }
  const length = payload.t.length;
  if (length > 10_000) fail('too_many_candles', 'A single history response is limited to 10000 candles');
  if (['o', 'h', 'l', 'c'].some(field => payload[field].length !== length)) {
    fail('array_length_mismatch', 'Timestamp and OHLC arrays must have equal length');
  }
  const hasVolume = payload.v !== undefined;
  if (hasVolume && (!Array.isArray(payload.v) || payload.v.length !== length)) {
    fail('array_length_mismatch', 'Volume array must have the same length as timestamps');
  }

  let previousTime = null;
  for (let index = 0; index < length; index++) {
    const time = payload.t[index];
    if (!Number.isSafeInteger(time) || time < 0) fail('invalid_timestamp', `Invalid timestamp at index ${index}`);
    if (previousTime !== null && time <= previousTime) fail('timestamp_order', 'History timestamps must be strictly increasing');
    if (time % periodSeconds !== 0) fail('timestamp_alignment', `Timestamp is not aligned to ${resolution} at index ${index}`);
    if (time * 1000 > nowMs) fail('future_timestamp', `Candle starts after the observation time at index ${index}`);

    const [open, high, low, close] = ['o', 'h', 'l', 'c'].map(field => payload[field][index]);
    if (![open, high, low, close].every(value => finiteNumber(value) && value > 0)) {
      fail('invalid_price', `OHLC prices must be positive finite numbers at index ${index}`);
    }
    if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
      fail('invalid_ohlc', `OHLC bounds are inconsistent at index ${index}`);
    }
    const volume = hasVolume ? payload.v[index] : null;
    if (hasVolume && (!finiteNumber(volume) || volume < 0)) fail('invalid_volume', `Invalid volume at index ${index}`);
    const candle = { time, open, high, low, close, volume };
    if ((time + periodSeconds) * 1000 <= nowMs) closedCandles.push(candle);
    else formingCandles.push(candle);

    if (previousTime !== null && time - previousTime > periodSeconds) {
      gaps.push({ afterTime: previousTime, beforeTime: time, missingBars: (time - previousTime) / periodSeconds - 1 });
    }
    previousTime = time;
  }

  const latestClosedTime = closedCandles.at(-1)?.time ?? null;
  const latestClosedAtMs = latestClosedTime === null ? null : (latestClosedTime + periodSeconds) * 1000;
  const closedLagMs = latestClosedAtMs === null ? null : nowMs - latestClosedAtMs;
  return {
    status: length ? 'ok' : 'no_data', resolution: String(resolution), periodSeconds, closedCandles, formingCandles, gaps,
    latestClosedTime, latestClosedAtMs, closedLagMs,
    stale: closedLagMs === null || closedLagMs > staleAfterMs,
    staleAfterMs,
  };
}

/**
 * Plan a state transition without I/O. First contact establishes a baseline and
 * emits no historical candles as newly observed live events. Stable event IDs
 * let the caller reconcile a journal written before a crash/state-save failure.
 */
export function planClosedCandleUpdate(previousState, validation, { symbol, resolution } = {}) {
  if (typeof symbol !== 'string' || !/^[A-Z0-9]{1,12}$/.test(symbol)) fail('invalid_symbol', 'Symbol must use 1–12 uppercase letters/digits');
  const normalizedResolution = String(resolution);
  const periodSeconds = resolutionSeconds(normalizedResolution);
  if (!validation || validation.resolution !== normalizedResolution || !Array.isArray(validation.closedCandles)) {
    fail('invalid_validation', 'A validation for the same resolution is required');
  }
  if (previousState !== null && previousState !== undefined) {
    if (typeof previousState !== 'object' || Array.isArray(previousState)
      || previousState.symbol !== symbol || previousState.resolution !== normalizedResolution
      || !(previousState.lastClosedTime === null || (Number.isSafeInteger(previousState.lastClosedTime) && previousState.lastClosedTime >= 0))) {
      fail('invalid_previous_state', 'Saved stream state is invalid or belongs to a different stream');
    }
    if (previousState.lastClosedTime !== null && previousState.lastClosedTime % periodSeconds !== 0) {
      fail('invalid_previous_state', 'Saved candle timestamp is not aligned to its resolution');
    }
  }

  const lastClosedTime = previousState?.lastClosedTime ?? null;
  const latestClosedTime = validation.closedCandles.at(-1)?.time ?? null;
  if (lastClosedTime !== null && latestClosedTime !== null && latestClosedTime < lastClosedTime) {
    fail('history_regression', 'History ends before the saved closed candle; keep the existing checkpoint');
  }
  const mode = lastClosedTime === null ? 'warmup' : 'update';
  const newCandles = mode === 'warmup' ? [] : validation.closedCandles.filter(candle => candle.time > lastClosedTime);
  const firstNewTime = newCandles[0]?.time ?? null;
  const recoveryGap = firstNewTime !== null && firstNewTime - lastClosedTime > periodSeconds
    ? { afterTime: lastClosedTime, beforeTime: firstNewTime, missingBars: (firstNewTime - lastClosedTime) / periodSeconds - 1 }
    : null;
  return {
    mode,
    nextState: { symbol, resolution: normalizedResolution, lastClosedTime: latestClosedTime ?? lastClosedTime },
    newCandles,
    eventIds: newCandles.map(candle => `${symbol}:${normalizedResolution}:${candle.time}`),
    warmupCandles: mode === 'warmup' ? validation.closedCandles.length : 0,
    recoveryGap,
  };
}
