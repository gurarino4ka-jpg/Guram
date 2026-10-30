import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../monitor/store.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guram-monitor-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const event = (id, close = 100) => ({ id, type: 'candle_closed', symbol: 'BTC', close });

test('exclusive lock rejects another monitor and ordinary release permits restart', async t => {
  const directory = await fixture(t);
  const first = await createStore(directory);
  const second = await createStore(directory);
  await first.acquireLock();
  await assert.rejects(second.acquireLock(), { code: 'ESTORAGE_LOCKED' });
  await assert.rejects(second.writeState({ version: 1 }), { code: 'ESTORAGE_NOT_LOCKED' });
  await first.releaseLock();
  await second.acquireLock();
  await second.releaseLock();
});

test('a stale lock is never silently stolen', async t => {
  const directory = await fixture(t);
  const lock = { pid: 2147483647, token: 'stale', createdAt: '2000-01-01T00:00:00Z' };
  await fs.writeFile(path.join(directory, 'monitor.lock'), JSON.stringify(lock));
  const store = await createStore(directory);
  await assert.rejects(store.acquireLock(), { code: 'ESTORAGE_LOCKED' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'monitor.lock'), 'utf8')), lock);
});

test('journal deduplicates batches, concurrent appends and restart after append-before-state crash', async t => {
  const directory = await fixture(t);
  const store = await createStore(directory);
  await store.acquireLock();
  assert.equal(await store.readState(), null);
  await store.writeState({ lastClosedTime: 1 });
  assert.equal(await store.appendEvents([event('BTC:60:2'), event('BTC:60:2')]), 1);
  const counts = await Promise.all([
    store.appendEvents([event('BTC:60:2'), event('BTC:60:3')]),
    store.appendEvents([event('BTC:60:3'), event('BTC:60:4')])
  ]);
  assert.deepEqual(counts, [1, 1]);
  // Emulate restart when the journal was durable but the state had not advanced.
  await store.releaseLock();
  const restarted = await createStore(directory);
  await restarted.acquireLock();
  assert.equal((await restarted.readState()).lastClosedTime, 1);
  assert.equal(await restarted.appendEvents([event('BTC:60:2'), event('BTC:60:3'), event('BTC:60:4')]), 0);
  await restarted.writeState({ lastClosedTime: 4 });
  const lines = (await fs.readFile(path.join(directory, 'journal.jsonl'), 'utf8')).trim().split('\n');
  assert.deepEqual(lines.map(line => JSON.parse(line).id), ['BTC:60:2', 'BTC:60:3', 'BTC:60:4']);
  await restarted.releaseLock();
});

test('atomic state, status and snapshot files replace previous contents without leftover temp files', async t => {
  const directory = await fixture(t);
  const store = await createStore(directory);
  await store.acquireLock();
  await store.writeState({ version: 1 });
  await store.writeState({ version: 2 });
  await store.writeStatus({ healthy: true });
  await store.writeSnapshot('BTC', '60', { closedCandles: [{ close: 100 }] });
  assert.deepEqual(await store.readState(), { version: 2 });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8')), { healthy: true });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'snapshots', 'BTC-60.json'), 'utf8')), { closedCandles: [{ close: 100 }] });
  assert.ok((await fs.readdir(directory)).every(name => !name.endsWith('.tmp')));
  assert.throws(() => store.writeSnapshot('../BTC', '60', {}), /Invalid snapshot/);
  assert.throws(() => store.writeSnapshot('BTC', '../../outside', {}), /Invalid snapshot/);
  await store.releaseLock();
});

for (const content of ['{"id":"a"}', '{broken}\n', '{"id":"a"}\n{"id":"a"}\n', '{"type":"candle_closed"}\n']) {
  test(`malformed or truncated journal is preserved and stops startup: ${JSON.stringify(content)}`, async t => {
    const directory = await fixture(t);
    await fs.writeFile(path.join(directory, 'journal.jsonl'), content);
    const store = await createStore(directory);
    await assert.rejects(store.acquireLock(), { code: 'ESTORAGE_CORRUPT' });
    assert.equal(await fs.readFile(path.join(directory, 'journal.jsonl'), 'utf8'), content);
    await assert.rejects(fs.access(path.join(directory, 'monitor.lock')), { code: 'ENOENT' });
  });
}

test('corrupt state never silently resets the saved stream positions', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'state.json'), '{broken}');
  const store = await createStore(directory);
  await store.acquireLock();
  await assert.rejects(store.readState(), { code: 'ESTORAGE_CORRUPT' });
  assert.equal(await fs.readFile(path.join(directory, 'state.json'), 'utf8'), '{broken}');
  await store.releaseLock();
});

test('validate the whole event batch before appending any line', async t => {
  const directory = await fixture(t);
  const store = await createStore(directory);
  await store.acquireLock();
  await assert.rejects(store.appendEvents([event('valid'), { type: 'bad' }]), /requires/);
  await assert.rejects(store.appendEvents([{ id: 'hidden', toJSON: () => ({ type: 'bad' }) }]), /requires/);
  await assert.rejects(fs.access(path.join(directory, 'journal.jsonl')), { code: 'ENOENT' });
  assert.equal(await store.appendEvents([event('valid')]), 1);
  await store.releaseLock();
});

test('uncertain journal write failure blocks further writes until restart', async t => {
  const directory = await fixture(t);
  const store = await createStore(directory);
  await store.acquireLock();
  await store.writeState({ version: 1 });
  await fs.mkdir(path.join(directory, 'journal.jsonl'));
  await assert.rejects(store.appendEvents([event('BTC:60:2')]));
  await assert.rejects(store.writeState({ version: 2 }), { code: 'ESTORAGE_WRITE_FAILED' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')), { version: 1 });
  await store.releaseLock();
});

test('changed lock ownership prevents writes and does not remove the replacement lock', async t => {
  const directory = await fixture(t);
  const store = await createStore(directory);
  await store.acquireLock();
  const replacement = { pid: process.pid, token: 'replacement' };
  await fs.writeFile(path.join(directory, 'monitor.lock'), JSON.stringify(replacement));
  await assert.rejects(store.writeState({ version: 1 }), { code: 'ESTORAGE_LOCK_CHANGED' });
  await assert.rejects(store.releaseLock(), { code: 'ESTORAGE_LOCK_CHANGED' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'monitor.lock'), 'utf8')), replacement);
});
