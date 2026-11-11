import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  validateMarketIdentity, validateArchiveCandle, createCandleKey,
  createCandleHash, createRecordHash, createStoredCandleHash,
} from './archive-schema.mjs';

export class ArchiveStoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ArchiveStoreError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ArchiveStoreError(code, message, cause);
}

function sha(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function validateBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) fail('invalid_batch', 'Batch must be an object.');
  const market = validateMarketIdentity(batch.market);
  if (!Array.isArray(batch.candles)) fail('invalid_batch', 'Candles must be an array.');
  if (batch.candles.length > 10_000) fail('invalid_batch', 'Too many candles in one observation.');
  const seen = new Set();
  const candles = batch.candles.map(candle => {
    const checked = validateArchiveCandle(candle, market);
    const candleKey = createCandleKey(market, checked.openTimeMs);
    if (seen.has(candleKey)) fail('duplicate_candle', 'Duplicate candle in observation.');
    seen.add(candleKey);
    return { candleKey, checked, contentHash: createCandleHash(candle, market) };
  });
  return candles;
}

/**
 * Independent single-writer archive. The journal is the source of truth.
 * Each observation is one checksummed JSONL line: partial writes fail closed.
 * Caller must explicitly repair any incomplete tail; no silent truncation.
 */
export async function createCandleArchive(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) fail('invalid_directory', 'Data directory is required.');
  const root = path.resolve(dataDir, 'archive', 'v1');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('invalid_directory', 'Archive directory must be regular.');
  const journal = path.join(root, 'observations.jsonl');
  const lock = path.join(root, 'archive.lock');
  let lockHandle = null;
  let lockToken = null;
  let state = new Map();
  let batches = new Set();
  let poisoned = false;
  let queue = Promise.resolve();
  const serial = fn => {
    const task = queue.then(fn);
    queue = task.catch(() => {});
    return task;
  };

  async function assertOpen() {
    if (!lockHandle) fail('not_open', 'Archive is not open.');
    if (poisoned) fail('write_failed', 'Previous write failed; close and inspect archive.');
    let actual;
    try { actual = JSON.parse(await fs.readFile(lock, 'utf8')); }
    catch (error) { fail('lock_changed', 'Archive lock is missing or invalid.', error); }
    if (actual.token !== lockToken || actual.pid !== process.pid) {
      fail('lock_changed', 'Archive lock ownership changed; refusing to write.');
    }
  }

  function applyBatch(entries) {
    const next = new Map(state);
    for (const entry of entries) {
      const history = next.get(entry.candleKey) ?? [];
      next.set(entry.candleKey, [...history, entry]);
    }
    state = next;
  }

  async function load() {
    let data;
    try { data = await fs.readFile(journal, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      fail('corrupt_journal', 'Cannot read archive journal.', error);
    }
    if (data && !data.endsWith('\n')) fail('corrupt_journal', 'Incomplete archive journal tail; preserve before repair.');
    const rows = data ? data.slice(0, -1).split('\n') : [];
    for (let index = 0; index < rows.length; index++) {
      try {
        const batch = JSON.parse(rows[index]);
        if (!batch || batch.version !== 1 || !Array.isArray(batch.entries) ||
            typeof batch.id !== 'string' || typeof batch.checksum !== 'string') throw new Error('Invalid batch.');
        const payload = JSON.stringify({version: batch.version, id: batch.id, entries: batch.entries});
        if (sha(payload) !== batch.checksum || batches.has(batch.id)) throw new Error('Checksum or batch id invalid.');
        const pending = new Map();
        for (const entry of batch.entries) {
          if (!entry || typeof entry.candleKey !== 'string' ||
              !Number.isSafeInteger(entry.revision) || entry.revision < 1 ||
              !Number.isSafeInteger(entry.knownAtMs) || entry.knownAtMs < 0 ||
              !/^[a-f0-9]{64}$/.test(entry.contentHash) ||
              !/^[a-f0-9]{64}$/.test(entry.recordHash) ||
              entry.recordHash !== createRecordHash(entry) ||
              entry.contentHash !== createStoredCandleHash(entry)) throw new Error('Invalid revision.');
          const previous = pending.get(entry.candleKey) ?? state.get(entry.candleKey) ?? [];
          const last = previous.at(-1);
          if (entry.revision !== (last?.revision ?? 0) + 1 ||
              entry.previousRevisionHash !== (last?.recordHash ?? null) ||
              (last && entry.knownAtMs < last.knownAtMs) ||
              (last && entry.contentHash === last.contentHash)) throw new Error('Invalid revision chain.');
          pending.set(entry.candleKey, [...previous, entry]);
        }
        applyBatch(batch.entries);
        batches.add(batch.id);
      } catch (error) {
        fail('corrupt_journal', 'Invalid archive journal line ' + (index + 1) + '. Preserve and repair before restart.', error);
      }
    }
  }

  return {
    directory: root,
    open: () => serial(async () => {
      if (lockHandle) fail('already_open', 'Archive is already open.');
      try { lockHandle = await fs.open(lock, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') fail('locked', 'Archive lock exists. Check the prior process before removing it.');
        throw error;
      }
      try {
        lockToken = randomUUID();
        await lockHandle.writeFile(JSON.stringify({pid:process.pid,token:lockToken,createdAt:new Date().toISOString()})+'\n');
        await lockHandle.sync();
        // Rebuild from disk on every open; never replay into a prior in-memory state.
        state = new Map();
        batches = new Set();
        poisoned = false;
        await load();
      } catch (error) {
        const ownedToken = lockToken;
        await lockHandle.close().catch(()=>{});
        lockHandle = null;
        lockToken = null;
        // Do not delete a replacement lock installed while journal replay failed.
        try {
          const current = JSON.parse(await fs.readFile(lock, 'utf8'));
          if (current.token === ownedToken && current.pid === process.pid) {
            await fs.unlink(lock);
          }
        } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') {
            fail('lock_cleanup_failed', 'Archive failed to open and lock cleanup was not verified; inspect lock manually.', cleanupError);
          }
        }
        throw error;
      }
    }),
    appendObservation: batch => serial(async () => {
      await assertOpen();
      const candles = validateBatch(batch);
      const entries = [];
      const counts = {newCandles:0, revisions:0, unchanged:0};
      for (const item of candles) {
        const history = state.get(item.candleKey) ?? [];
        const previous = history.at(-1);
        if (previous?.contentHash === item.contentHash) { counts.unchanged++; continue; }
        if (previous && item.checked.knownAtMs < previous.knownAtMs) {
          fail('observation_order', 'New revision cannot predate previous revision.');
        }
        const entry = {
          candleKey: item.candleKey, revision: (previous?.revision ?? 0) + 1,
          contentHash: item.contentHash, knownAtMs: item.checked.knownAtMs,
          previousRevisionHash: previous?.recordHash ?? null,
          candle: {
            openTimeMs: item.checked.openTimeMs, open: item.checked.open, high: item.checked.high,
            low: item.checked.low, close: item.checked.close, volume: item.checked.volume,
          },
          marketId: item.checked.marketId, resolution: item.checked.resolution,
          snapshotTimeMs: item.checked.snapshotTimeMs, receivedAtMs: item.checked.receivedAtMs,
        };
        entry.recordHash = createRecordHash(entry);
        entries.push(entry);
        if (previous) counts.revisions++; else counts.newCandles++;
      }
      if (!entries.length) return counts;
      const payload = {version:1, id:randomUUID(), entries};
      const line = JSON.stringify({...payload, checksum:sha(JSON.stringify(payload))})+'\n';
      let handle;
      try {
        handle = await fs.open(journal, 'a', 0o600);
        await handle.writeFile(line, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        // Persist directory entry too (important when the journal was created).
        await syncDirectory(root);
        applyBatch(entries);
        batches.add(payload.id);
        return counts;
      } catch (error) {
        poisoned = true;
        fail('write_failed', 'Archive write failed. Stop and inspect the journal.', error);
      } finally {
        if (handle) await handle.close().catch(()=>{});
      }
    }),
    getCandle: ({identity,openTimeMs,asOf} = {}) => {
      if (!lockHandle || poisoned) fail('not_ready', 'Archive must be open and healthy before reads.');
      const key = createCandleKey(identity, openTimeMs);
      if (asOf !== undefined && (!Number.isSafeInteger(asOf) || asOf < 0)) fail('invalid_as_of', 'Invalid asOf.');
      const versions = state.get(key) ?? [];
      const result = asOf === undefined ? versions.at(-1) : versions.filter(v => v.knownAtMs <= asOf).at(-1);
      return result ? structuredClone(result) : null;
    },
    getRevisions: (identity,openTimeMs) => {
      if (!lockHandle || poisoned) fail('not_ready', 'Archive must be open and healthy before reads.');
      return structuredClone(state.get(createCandleKey(identity,openTimeMs)) ?? []);
    },
    close: () => serial(async () => {
      if (!lockHandle) return;
      let actual;
      try { actual = JSON.parse(await fs.readFile(lock, 'utf8')); }
      catch (error) { fail('lock_changed', 'Archive lock is missing or invalid.', error); }
      if (actual.token !== lockToken || actual.pid !== process.pid) {
        fail('lock_changed', 'Archive lock ownership changed; refusing to remove it.');
      }
      await lockHandle.close();
      lockHandle = null;
      lockToken = null;
      await fs.unlink(lock);
    }),
  };
}
