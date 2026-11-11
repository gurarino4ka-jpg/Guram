import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
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

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
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
  let journalIdentity = null;
  let queue = Promise.resolve();
  const serial = fn => {
    const task = queue.then(fn);
    queue = task.catch(() => {});
    return task;
  };

  async function verifyLockOwnership() {
    if (!lockHandle) fail('not_open', 'Archive is not open.');
    let actual, heldStat, pathStat;
    try {
      [actual, heldStat, pathStat] = await Promise.all([
        fs.readFile(lock, 'utf8').then(JSON.parse),
        lockHandle.stat(),
        fs.lstat(lock),
      ]);
    } catch (error) {
      fail('lock_changed', 'Archive lock is missing or invalid.', error);
    }
    if (!pathStat.isFile() || pathStat.isSymbolicLink() ||
        heldStat.dev !== pathStat.dev || heldStat.ino !== pathStat.ino ||
        actual.token !== lockToken || actual.pid !== process.pid) {
      fail('lock_changed', 'Archive lock ownership or file identity changed.');
    }
  }

  async function assertOpen() {
    if (!lockHandle) fail('not_open', 'Archive is not open.');
    if (poisoned) fail('write_failed', 'Previous write failed; close and inspect archive.');
    await verifyLockOwnership();
  }

  function applyBatch(entries) {
    const next = new Map(state);
    for (const entry of entries) {
      const history = next.get(entry.candleKey) ?? [];
      next.set(entry.candleKey, [...history, entry]);
    }
    state = next;
  }

  async function load(data) {
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
        await syncDirectory(root);
        // Rebuild from disk on every open; never replay into a prior in-memory state.
        state = new Map();
        batches = new Set();
        poisoned = false;
        const existingJournal = await fs.lstat(journal).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (existingJournal && (!existingJournal.isFile() || existingJournal.isSymbolicLink())) {
          fail('invalid_journal', 'Archive journal must be a regular file.');
        }
        if (existingJournal) {
          // Replay and pin the same file descriptor, not a path read followed
          // by an unrelated lstat that could identify a replacement file.
          const reader = await fs.open(journal, 'r');
          try {
            const opened = await reader.stat();
            if (!opened.isFile() || opened.dev !== existingJournal.dev ||
                opened.ino !== existingJournal.ino) {
              fail('invalid_journal', 'Journal changed before replay.');
            }
            const data = await reader.readFile('utf8');
            const after = await fs.lstat(journal);
            if (!after.isFile() || after.isSymbolicLink() ||
                after.dev !== opened.dev || after.ino !== opened.ino ||
                after.size !== opened.size) {
              fail('invalid_journal', 'Journal changed during replay.');
            }
            await load(data);
            journalIdentity = {dev:opened.dev,ino:opened.ino,size:opened.size,hash:sha(data)};
          } finally {
            await reader.close();
          }
        } else {
          // A newly appearing journal will be rejected by exclusive creation.
          journalIdentity = null;
        }
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
            await syncDirectory(root);
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
        // Refuse to follow a symlink or append to a non-regular journal.
        // This check does not prevent a concurrent pathname swap after lstat.
        let journalStat;
        try { journalStat = await fs.lstat(journal); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (journalStat && (!journalStat.isFile() || journalStat.isSymbolicLink())) {
          fail('invalid_journal', 'Archive journal must be a regular file.');
        }
        // The first journal must be created exclusively: an unexpected file
        // installed after open() must never be appended without replay.
        // Once pinned, open without O_CREAT so deletion cannot silently
        // recreate an empty journal before the identity check.
        if (journalIdentity === null) {
          if (journalStat) fail('invalid_journal', 'Journal appeared after archive open.');
          handle = await fs.open(journal, 'ax', 0o600);
        } else {
          if (!journalStat) fail('invalid_journal', 'Pinned journal disappeared.');
          handle = await fs.open(journal, fsConstants.O_RDWR | fsConstants.O_APPEND);
        }
        const openedStat = await handle.stat();
        const pathStat = await fs.lstat(journal);
        if (!openedStat.isFile() || !pathStat.isFile() ||
            openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino ||
            (journalIdentity && (openedStat.dev !== journalIdentity.dev || openedStat.ino !== journalIdentity.ino ||
              openedStat.size !== journalIdentity.size))) {
          fail('invalid_journal', 'Archive journal identity changed before append.');
        }
        // Detect same-size in-place tampering since the last successful replay/append.
        // This is O(journal size) per append; benchmark before production use.
        const priorData = journalIdentity === null ? '' : await handle.readFile('utf8');
        const preWriteStat = await handle.stat();
        if (preWriteStat.size !== openedStat.size ||
            (journalIdentity && sha(priorData) !== journalIdentity.hash)) {
          fail('invalid_journal', 'Archive journal content changed since last verified state.');
        }
        await handle.writeFile(line, 'utf8');
        await handle.sync();
        const writtenStat = await handle.stat();
        if (writtenStat.size !== openedStat.size + Buffer.byteLength(line, 'utf8')) {
          fail('invalid_journal', 'Archive journal size changed unexpectedly during append.');
        }
        await handle.close();
        handle = null;
        // Persist directory entry too (important when the journal was created).
        await syncDirectory(root);
        journalIdentity = {dev:openedStat.dev,ino:openedStat.ino,size:writtenStat.size,hash:sha(priorData+line)};
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
      try {
        await verifyLockOwnership();
      } catch (error) {
        // Release our descriptor even when the pathname belongs to another writer.
        // Never unlink an unverified lock or allow stale in-memory reads.
        poisoned = true;
        await lockHandle.close().catch(() => {});
        lockHandle = null;
        lockToken = null;
        throw error;
      }
      await lockHandle.close();
      lockHandle = null;
      lockToken = null;
      await fs.unlink(lock);
      await syncDirectory(root);
    }),
  };
}
