import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class StoreError extends Error {
  constructor(message, code, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'StoreError';
    this.code = code;
  }
}

const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function jsonText(value) {
  if (!isRecord(value)) throw new TypeError('Storage JSON value must be an object.');
  const text = JSON.stringify(value, null, 2);
  if (typeof text !== 'string' || !isRecord(JSON.parse(text))) throw new TypeError('Storage JSON value must serialize to an object.');
  return `${text}\n`;
}

function eventId(event) {
  if (!isRecord(event) || typeof event.id !== 'string' || !event.id.trim() || event.id.length > 512 || /[\r\n\0]/.test(event.id)) {
    throw new TypeError('Journal event requires a nonempty string id.');
  }
  return event.id;
}

async function readJson(file, missing = null) {
  try {
    const value = JSON.parse(decode(await fs.readFile(file)));
    if (!isRecord(value)) throw new Error('Expected an object.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return missing;
    throw new StoreError(`Cannot read valid JSON from ${file}. Preserve the file and repair it before restarting.`, 'ESTORAGE_CORRUPT', error);
  }
}

async function syncDirectory(directory) {
  // Windows does not support opening a directory as a file for fsync.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(file, value) {
  const content = jsonText(value);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function readJournalIds(file) {
  let content;
  try { content = decode(await fs.readFile(file)); }
  catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw new StoreError(`Cannot read journal ${file}.`, 'ESTORAGE_CORRUPT', error);
  }
  if (content && !content.endsWith('\n')) {
    throw new StoreError(`Journal ${file} has an incomplete final line. Preserve it and repair it before restarting.`, 'ESTORAGE_CORRUPT');
  }
  const ids = new Set();
  const lines = content ? content.slice(0, -1).split('\n') : [];
  for (let index = 0; index < lines.length; index++) {
    try {
      const id = eventId(JSON.parse(lines[index]));
      if (ids.has(id)) throw new Error('Duplicate event id.');
      ids.add(id);
    } catch (error) {
      throw new StoreError(`Invalid journal line ${index + 1} in ${file}. Preserve it and repair it before restarting.`, 'ESTORAGE_CORRUPT', error);
    }
  }
  return ids;
}

function snapshotName(symbol, resolution) {
  if (!/^[A-Z][A-Z0-9]{0,15}$/.test(symbol) || !/^[A-Za-z0-9]{1,8}$/.test(String(resolution))) {
    throw new TypeError('Invalid snapshot symbol or resolution.');
  }
  return `${symbol}-${resolution}.json`;
}

/** No account sessions or credentials are stored here. All writes require the lock. */
export async function createStore(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new TypeError('A data directory is required.');
  const directory = path.resolve(dataDir);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreError('Data directory must be a regular directory.', 'ESTORAGE_DIRECTORY');
  const snapshots = path.join(directory, 'snapshots');
  await fs.mkdir(snapshots, { recursive: true, mode: 0o700 });
  const snapshotInfo = await fs.lstat(snapshots);
  if (!snapshotInfo.isDirectory() || snapshotInfo.isSymbolicLink()) throw new StoreError('Snapshot directory must be a regular directory.', 'ESTORAGE_DIRECTORY');
  const lockFile = path.join(directory, 'monitor.lock');
  const journalFile = path.join(directory, 'journal.jsonl');
  let held = null;
  let ids = new Set();
  let writeFailure = null;
  let queue = Promise.resolve();
  const serial = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };

  async function assertLock() {
    if (!held) throw new StoreError('Acquire the monitor lock before accessing the store.', 'ESTORAGE_NOT_LOCKED');
    const actual = await readJson(lockFile);
    if (actual?.token !== held.token || actual?.pid !== process.pid) {
      throw new StoreError('Monitor lock ownership changed; refusing to write.', 'ESTORAGE_LOCK_CHANGED');
    }
    if (writeFailure) throw new StoreError('A previous storage write failed; restart after checking the data files.', 'ESTORAGE_WRITE_FAILED', writeFailure);
  }

  async function releaseOwnedLock() {
    if (!held) return;
    const actual = await readJson(lockFile);
    if (actual?.token !== held.token || actual?.pid !== process.pid) {
      throw new StoreError('Monitor lock ownership changed; the lock was not removed.', 'ESTORAGE_LOCK_CHANGED');
    }
    await fs.unlink(lockFile);
    held = null;
  }

  const writeJson = (file, value) => serial(async () => {
    await assertLock();
    try { await atomicJson(file, value); }
    catch (error) {
      writeFailure = error;
      throw new StoreError(`Storage write failed for ${file}; monitoring must stop.`, 'ESTORAGE_WRITE_FAILED', error);
    }
  });

  return {
    directory,
    acquireLock: () => serial(async () => {
      if (held) throw new StoreError('This store already holds its monitor lock.', 'ESTORAGE_LOCKED');
      const lock = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
      let handle;
      try { handle = await fs.open(lockFile, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        throw new StoreError(`Monitor lock exists: ${lockFile}. Stop the previous monitor first. After a crash, confirm it is stopped and remove only monitor.lock.`, 'ESTORAGE_LOCKED');
      }
      try {
        await handle.writeFile(jsonText(lock), 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        held = lock;
        ids = await readJournalIds(journalFile);
        writeFailure = null;
        return { pid: lock.pid, createdAt: lock.createdAt };
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (held) await releaseOwnedLock();
        else await fs.unlink(lockFile).catch(() => {});
        throw error;
      }
    }),
    releaseLock: () => serial(releaseOwnedLock),
    readState: () => serial(async () => { await assertLock(); return readJson(path.join(directory, 'state.json')); }),
    writeState: value => writeJson(path.join(directory, 'state.json'), value),
    writeSnapshot: (symbol, resolution, value) => writeJson(path.join(snapshots, snapshotName(symbol, resolution)), value),
    writeStatus: value => writeJson(path.join(directory, 'status.json'), value),
    appendEvents: events => serial(async () => {
      await assertLock();
      if (!Array.isArray(events)) throw new TypeError('Journal events must be an array.');
      const pending = new Map();
      for (const event of events) {
        const id = eventId(event);
        if (!ids.has(id) && !pending.has(id)) {
          const serialized = JSON.stringify(event);
          if (typeof serialized !== 'string' || eventId(JSON.parse(serialized)) !== id) {
            throw new TypeError('Journal event must serialize with its original id.');
          }
          pending.set(id, serialized);
        }
      }
      if (!pending.size) return 0;
      let handle;
      try {
        handle = await fs.open(journalFile, 'a', 0o600);
        await handle.writeFile(`${[...pending.values()].join('\n')}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await syncDirectory(directory);
        for (const id of pending.keys()) ids.add(id);
        return pending.size;
      } catch (error) {
        writeFailure = error;
        throw new StoreError(`Journal write failed for ${journalFile}; monitoring must stop.`, 'ESTORAGE_WRITE_FAILED', error);
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
    })
  };
}
