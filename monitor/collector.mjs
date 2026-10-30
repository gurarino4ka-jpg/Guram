import { createHash } from 'node:crypto';
import { validateUdfHistory, planClosedCandleUpdate } from './core.mjs';

function validateState(state) {
  if (state === null) return { version: 1, streams: {}, healthSignature: null };
  if (!state || state.version !== 1 || !state.streams || typeof state.streams !== 'object' || Array.isArray(state.streams)
    || !(state.healthSignature === null || typeof state.healthSignature === 'string')) throw new Error('Invalid saved monitor state; do not reset it automatically.');
  return { ...state, streams: { ...state.streams } };
}

/** Collect public data only. There is no account connection, signal engine or order operation. */
export async function collectOnce({ provider, store, config, previousState = null, now = Date.now, signal } = {}) {
  const startedAtMs = now();
  const state = validateState(previousState);
  const issues = [], streams = [], events = [];
  let quotes = [], retryAfterMs = 0;
  function sourceError(stream, error) {
    const sourceDelay = error.status === 429 ? Math.max(config.pollSeconds * 1000, Number(error.retryAfterMs) || 0) : Number(error.retryAfterMs) || 0;
    retryAfterMs = Math.max(retryAfterMs, sourceDelay);
    issues.push({ stream, code: typeof error.code === 'string' ? error.code : 'source_error', ...(error.status ? { httpStatus: error.status } : {}) });
  }
  try {
    const result = await provider.fetchQuotes(config.symbols);
    quotes = result.quotes.map(quote => ({ ...quote, ageSeconds: Math.max(0, (result.receivedAtMs - quote.timeMs) / 1000), stale: result.receivedAtMs - quote.timeMs > config.maxQuoteAgeSeconds * 1000 }));
    for (const quote of quotes) if (quote.stale) issues.push({ stream: quote.symbol, code: 'stale_quote' });
  } catch (error) { sourceError('quotes', error); }

  const jobs = config.symbols.flatMap(symbol => config.resolutions.map(resolution => ({ symbol, resolution })));
  let nextJob = 0;
  let storageFailure;
  async function worker() {
    while (nextJob < jobs.length && !signal?.aborted && !storageFailure) {
      const { symbol, resolution } = jobs[nextJob++];
      const key = `${symbol}:${resolution}`;
      if (retryAfterMs) { issues.push({ stream: key, code: 'source_cooldown' }); continue; }
      let result, validation, plan;
      try {
        result = await provider.fetchHistory(symbol, resolution, { countback: config.countback });
        // A response can cross a candle boundary. Do not finalize an OHLC sampled before it closed.
        validation = validateUdfHistory(result.payload, { resolution, nowMs: result.snapshotTimeMs ?? result.receivedAtMs, maxClosedLagPeriods: config.maxClosedLagPeriods });
        plan = planClosedCandleUpdate(state.streams[key], validation, { symbol, resolution });
      } catch (error) { sourceError(key, error); continue; }
      // Disk failures propagate and stop the process; they are not labelled as network failures.
      try {
        await store.writeSnapshot(symbol, resolution, { receivedAt: new Date(result.receivedAtMs).toISOString(), snapshotTime: new Date(result.snapshotTimeMs ?? result.receivedAtMs).toISOString(), source: result.sourceUrl, symbol, resolution, ...validation });
      } catch (error) { storageFailure = error; throw error; }
      if (validation.stale) issues.push({ stream: key, code: 'stale_candles' });
      if (validation.gaps.length) issues.push({ stream: key, code: 'history_gap', missingBars: validation.gaps.reduce((sum, gap) => sum + gap.missingBars, 0) });
      if (plan.recoveryGap) issues.push({ stream: key, code: 'recovery_gap', ...plan.recoveryGap });
      if (validation.closedCandles.length) {
        if (plan.mode === 'warmup') events.push({ id: `warmup:${key}:${plan.nextState.lastClosedTime}`, type: 'warmup', symbol, resolution, observedAt: new Date(result.receivedAtMs).toISOString(), candleCount: plan.warmupCandles, latestClosedTime: plan.nextState.lastClosedTime });
        for (let index = 0; index < plan.newCandles.length; index++) {
          events.push({ id: plan.eventIds[index], type: 'candle_closed', symbol, resolution, observedAt: new Date(result.receivedAtMs).toISOString(), candle: plan.newCandles[index], recovered: (plan.newCandles[index].time + validation.periodSeconds) * 1000 < startedAtMs - config.pollSeconds * 1000 });
        }
        state.streams[key] = plan.nextState;
      }
      streams.push({ symbol, resolution, latestClosedTime: validation.latestClosedTime, closedCandleCount: validation.closedCandles.length, formingCandleCount: validation.formingCandles.length, stale: validation.stale, gapCount: validation.gaps.length, mode: plan.mode, newClosedCandles: plan.newCandles.length });
    }
  }
  // Two requests at a time avoid a request burst and never overlap polling cycles.
  const workers = await Promise.allSettled([worker(), worker()]);
  const failedWorker = workers.find(result => result.status === 'rejected');
  if (failedWorker) throw failedWorker.reason;
  issues.sort((a, b) => a.stream.localeCompare(b.stream) || a.code.localeCompare(b.code));
  streams.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.resolution.localeCompare(b.resolution));
  events.sort((a, b) => a.id.localeCompare(b.id));
  const checkedAtMs = now();
  const health = signal?.aborted ? 'stopped' : issues.length || streams.length !== jobs.length ? 'degraded' : 'ok';
  const signature = createHash('sha256').update(JSON.stringify({ health, issues })).digest('hex');
  if (signature !== state.healthSignature) events.push({ id: `health:${checkedAtMs}:${signature}`, type: 'health_changed', observedAt: new Date(checkedAtMs).toISOString(), health, issues });
  state.healthSignature = signature;
  state.updatedAt = new Date(checkedAtMs).toISOString();
  // Journal first, checkpoint second. Stable event IDs deduplicate replay after a crash.
  const appendedEvents = await store.appendEvents(events);
  await store.writeState(state);
  const status = { version: 1, checkedAt: state.updatedAt, running: !signal?.aborted, source: 'UpScale/Bookflow public CRYPTO USD data', mode: 'data-only', executionEnabled: false, health, expectedStreams: jobs.length, completedStreams: streams.length, quotes, streams, issues, appendedEvents, retryAfterMs, pollSeconds: config.pollSeconds };
  await store.writeStatus(status);
  return { state, status, retryAfterMs };
}
