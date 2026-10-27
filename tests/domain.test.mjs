import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, currentPrice, openPosition, closePosition, nextCandle, equity, executionForCandle, restoreSession, updateNote, FEE_RATE } from '../public/domain.mjs';

function open(side = 'long', quantity = 5) {
  const state = createSession();
  const price = currentPrice(state);
  return openPosition(state, { side, quantity, stop: price * (side === 'long' ? .95 : 1.05), target: price * (side === 'long' ? 1.1 : .9) });
}

test('seeded candles repeat and preserve OHLC bounds', () => {
  assert.deepEqual(createSession(), createSession());
  let state = createSession();
  for (let step = 0; step < 600; step++) state = nextCandle(state);
  assert.equal(state.candles.length, 500);
  assert.ok(state.candles.every(c => c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close)));
  assert.ok(restoreSession(JSON.stringify(state)));
});

for (const side of ['long', 'short']) {
  test(`${side}: entry fee, unrealized equity and realized net PnL`, () => {
    const state = open(side);
    const { entry, quantity, entryFee } = state.position;
    assert.equal(state.balance, 10_000 - entry * quantity * FEE_RATE);
    assert.equal(equity(state), state.balance);
    const exit = entry + (side === 'long' ? 10 : -10);
    const closed = closePosition(state, exit);
    const fees = entryFee + exit * quantity * FEE_RATE;
    assert.ok(Math.abs(closed.trades[0].pnl - (50 - fees)) < 1e-9);
    assert.ok(Math.abs(closed.balance - (10_000 + closed.trades[0].pnl)) < 1e-9);
    assert.equal(closed.position, null);
    assert.equal(state.trades.length, 0, 'input remains immutable');
  });
}

test('rejects invalid inputs, mismatched protective levels and excessive notional including fees', () => {
  const state = createSession();
  const price = currentPrice(state);
  const params = { side: 'long', quantity: 1, stop: price - 5, target: price + 5 };
  for (const quantity of [0, -1, Infinity, NaN, '2']) assert.throws(() => openPosition(state, { ...params, quantity }));
  assert.throws(() => openPosition(state, { ...params, stop: price }));
  assert.throws(() => openPosition(state, { ...params, target: price - 1 }));
  assert.throws(() => openPosition(state, { ...params, side: 'short' }));
  assert.throws(() => openPosition(state, { ...params, quantity: 10_000 / price }), /Недостаточно/);
  assert.throws(() => openPosition(open(), params), /Сначала/);
  assert.throws(() => closePosition(state), /Нет открытой/);
  assert.throws(() => openPosition(state, { side: 'short', quantity: 5, stop: 100_000, target: 1 }), /Плановый убыток/);
  assert.throws(() => openPosition(state, { ...params, quantity: 8, target: 1e308 }), /слишком велики/);
});

test('long protective orders: stop-first on an ambiguous candle, stop gaps, favourable target gap', () => {
  const position = { side: 'long', stop: 95, target: 110 };
  assert.deepEqual(executionForCandle(position, { open: 100, low: 90, high: 115 }), { price: 95, reason: 'stop' });
  assert.deepEqual(executionForCandle(position, { open: 90, low: 89, high: 111 }), { price: 90, reason: 'stop' });
  assert.deepEqual(executionForCandle(position, { open: 112, low: 90, high: 115 }), { price: 112, reason: 'target' });
  assert.deepEqual(executionForCandle(position, { open: 100, low: 99, high: 111 }), { price: 110, reason: 'target' });
});

test('short protective orders invert stop/target and execute correctly across gaps', () => {
  const position = { side: 'short', stop: 105, target: 90 };
  assert.deepEqual(executionForCandle(position, { open: 100, low: 85, high: 110 }), { price: 105, reason: 'stop' });
  assert.deepEqual(executionForCandle(position, { open: 108, low: 85, high: 110 }), { price: 108, reason: 'stop' });
  assert.deepEqual(executionForCandle(position, { open: 88, low: 85, high: 110 }), { price: 88, reason: 'target' });
  assert.equal(executionForCandle(position, { open: 100, low: 95, high: 104 }), null);
});

test('advancing a candle actually closes a triggered position and records net PnL', () => {
  const state = createSession();
  const price = currentPrice(state);
  const position = openPosition(state, { side: 'long', quantity: 1, stop: price - .001, target: price + .001 });
  const next = nextCandle(position);
  assert.equal(next.position, null);
  assert.equal(next.trades.length, 1);
  assert.ok(Math.abs(next.balance - (10_000 + next.trades[0].pnl)) < 1e-9);
});

test('notes persist and malformed storage resets safely', () => {
  const closed = closePosition(open());
  const noted = updateNote(closed, closed.trades[0].id, 'Проверить вход после пробоя');
  assert.equal(restoreSession(JSON.stringify(noted)).trades[0].note, 'Проверить вход после пробоя');
  assert.equal(updateNote(noted, 1, 'x'.repeat(500)).trades[0].note.length, 400);
  for (const raw of ['{', 'null', '{}', JSON.stringify({ ...noted, balance: '100' }), JSON.stringify({ ...noted, seed: -1 }), JSON.stringify({ ...noted, candles: [{ index: 1, open: 10, high: 8, low: 1, close: 9 }] })]) {
    assert.equal(restoreSession(raw), null);
  }
  assert.equal(restoreSession({ ...noted, trades: [...noted.trades, noted.trades[0]] }), null);
  const opened = open();
  assert.equal(restoreSession({ ...opened, position: { ...opened.position, quantity: 1e308 } }), null);
  assert.equal(restoreSession({ ...noted, trades: [{ ...noted.trades[0], pnl: 100 }] }), null);
  assert.equal(restoreSession({ ...opened, balance: opened.balance + 100 }), null);
});
