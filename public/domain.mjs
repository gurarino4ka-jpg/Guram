export const FEE_RATE = 0.0005;
export const INITIAL_BALANCE = 10_000;
const HISTORY_LIMIT = 500;

function positive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}: укажите число больше нуля.`);
  }
}

function random(seed) {
  const next = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return [next, next / 4294967296];
}

export function generateCandle(previousClose, seed, index) {
  positive(previousClose, 'Цена');
  let draw;
  [seed, draw] = random(seed);
  const move = (draw - 0.49) * 0.024;
  const open = previousClose;
  const close = Math.max(1, Math.round(open * (1 + move) * 100) / 100);
  [seed, draw] = random(seed);
  const high = Math.round((Math.max(open, close) + open * draw * 0.006) * 100) / 100;
  [seed, draw] = random(seed);
  const low = Math.max(0.01, Math.round((Math.min(open, close) - open * draw * 0.006) * 100) / 100);
  return { seed, candle: { index, open, high, low, close } };
}

export function createSession(seed = 314159) {
  const state = {
    version: 1, seed: seed >>> 0, initialBalance: INITIAL_BALANCE,
    balance: INITIAL_BALANCE, candles: [], position: null, trades: [], nextId: 1,
  };
  let price = 124.5;
  for (let index = 0; index < 64; index += 1) {
    const generated = generateCandle(price, state.seed, index);
    state.seed = generated.seed;
    state.candles.push(generated.candle);
    price = generated.candle.close;
  }
  return state;
}

export function currentPrice(state) {
  return state.candles.at(-1).close;
}

export function unrealizedPnl(state) {
  const position = state.position;
  if (!position) return 0;
  return (currentPrice(state) - position.entry) * position.quantity * (position.side === 'long' ? 1 : -1);
}

export function equity(state) {
  return state.balance + unrealizedPnl(state);
}

export function openPosition(state, { side, quantity, stop, target }) {
  if (state.position) throw new Error('Сначала закройте текущую позицию.');
  if (!['long', 'short'].includes(side)) throw new Error('Выберите покупку или продажу.');
  positive(quantity, 'Количество');
  positive(stop, 'Стоп-лосс');
  positive(target, 'Тейк-профит');
  const entry = currentPrice(state);
  if (side === 'long' && !(stop < entry && target > entry)) {
    throw new Error('Для покупки стоп должен быть ниже цены, а цель — выше.');
  }
  if (side === 'short' && !(stop > entry && target < entry)) {
    throw new Error('Для продажи стоп должен быть выше цены, а цель — ниже.');
  }
  const notional = quantity * entry;
  const entryFee = notional * FEE_RATE;
  if (!Number.isFinite(notional) || notional + entryFee > state.balance) {
    throw new Error('Недостаточно средств: объём и комиссия не должны превышать баланс.');
  }
  if (!Number.isFinite(target * quantity)) {
    throw new Error('Цель и объём слишком велики для расчёта. Укажите меньшую цель.');
  }
  const plannedLoss = Math.abs(entry - stop) * quantity + entryFee + stop * quantity * FEE_RATE;
  if (!Number.isFinite(plannedLoss) || plannedLoss > state.balance) {
    throw new Error('Плановый убыток со стопом и комиссиями превышает баланс. Уменьшите объём или стоп.');
  }
  return {
    ...state,
    balance: state.balance - entryFee,
    position: { id: state.nextId, side, quantity, stop, target, entry, entryFee, openedAt: state.candles.at(-1).index },
    nextId: state.nextId + 1,
  };
}

export function closePosition(state, price = currentPrice(state), reason = 'manual') {
  if (!state.position) throw new Error('Нет открытой позиции.');
  positive(price, 'Цена закрытия');
  if (!['manual', 'stop', 'target'].includes(reason)) throw new Error('Неизвестная причина закрытия.');
  const position = state.position;
  const grossPnl = (price - position.entry) * position.quantity * (position.side === 'long' ? 1 : -1);
  const exitFee = price * position.quantity * FEE_RATE;
  const fees = position.entryFee + exitFee;
  const trade = {
    ...position, exit: price, closedAt: state.candles.at(-1).index,
    grossPnl, fees, pnl: grossPnl - fees, reason, note: '',
  };
  return { ...state, balance: state.balance + grossPnl - exitFee, position: null, trades: [...state.trades, trade].slice(-HISTORY_LIMIT) };
}

export function executionForCandle(position, candle) {
  if (!position) return null;
  const long = position.side === 'long';
  // A stop is a market order: a gap executes at the opening price.
  if ((long && candle.open <= position.stop) || (!long && candle.open >= position.stop)) {
    return { price: candle.open, reason: 'stop' };
  }
  // A target is a limit order: a favourable gap gets the opening price.
  if ((long && candle.open >= position.target) || (!long && candle.open <= position.target)) {
    return { price: candle.open, reason: 'target' };
  }
  // OHLC does not reveal intrabar ordering; assume the stop executes first.
  if ((long && candle.low <= position.stop) || (!long && candle.high >= position.stop)) {
    return { price: position.stop, reason: 'stop' };
  }
  if ((long && candle.high >= position.target) || (!long && candle.low <= position.target)) {
    return { price: position.target, reason: 'target' };
  }
  return null;
}

export function nextCandle(state) {
  const generated = generateCandle(currentPrice(state), state.seed, state.candles.at(-1).index + 1);
  let next = { ...state, seed: generated.seed, candles: [...state.candles, generated.candle].slice(-HISTORY_LIMIT) };
  const execution = executionForCandle(next.position, generated.candle);
  if (execution) next = closePosition(next, execution.price, execution.reason);
  return next;
}

export function updateNote(state, id, note) {
  return { ...state, trades: state.trades.map(trade => trade.id === id ? { ...trade, note: String(note).slice(0, 400) } : trade) };
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const finitePositive = value => finite(value) && value > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const almostEqual = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-12);

function validPosition(position) {
  return position && integer(position.id) && position.id > 0 && ['long', 'short'].includes(position.side)
    && ['quantity', 'entry', 'stop', 'target'].every(key => finitePositive(position[key]))
    && ['entry', 'stop', 'target'].every(key => finitePositive(position[key] * position.quantity))
    && finite(position.entryFee) && position.entryFee >= 0 && integer(position.openedAt)
    && almostEqual(position.entryFee, position.entry * position.quantity * FEE_RATE)
    && (position.side === 'long' ? position.stop < position.entry && position.target > position.entry : position.stop > position.entry && position.target < position.entry);
}

/** Reject damaged snapshots atomically instead of trusting partial trading state. */
export function restoreSession(raw) {
  try {
    const state = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!state || state.version !== 1 || !integer(state.seed) || state.seed > 4294967295
      || state.initialBalance !== INITIAL_BALANCE || !finite(state.balance)
      || !integer(state.nextId) || state.nextId < 1 || !Array.isArray(state.candles)
      || state.candles.length < 2 || state.candles.length > HISTORY_LIMIT || !Array.isArray(state.trades) || state.trades.length > HISTORY_LIMIT) return null;
    for (let index = 0; index < state.candles.length; index += 1) {
      const candle = state.candles[index];
      if (!candle || !integer(candle.index) || !['open', 'high', 'low', 'close'].every(key => finitePositive(candle[key]))
        || candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close)
        || (index && candle.index !== state.candles[index - 1].index + 1)) return null;
    }
    const lastIndex = state.candles.at(-1).index;
    if (state.position !== null && (!validPosition(state.position) || state.position.id >= state.nextId || state.position.openedAt > lastIndex
      || state.position.entry * state.position.quantity > state.balance + state.position.entryFee
      || Math.abs(state.position.entry - state.position.stop) * state.position.quantity + state.position.entryFee + state.position.stop * state.position.quantity * FEE_RATE > state.balance + state.position.entryFee)) return null;
    const ids = new Set();
    for (const trade of state.trades) {
      if (!validPosition(trade) || !finitePositive(trade.exit) || !integer(trade.closedAt)
        || trade.closedAt < trade.openedAt || !['grossPnl', 'fees', 'pnl'].every(key => finite(trade[key]))
        || trade.closedAt > lastIndex || !finite(trade.exit * trade.quantity)
        || !almostEqual(trade.grossPnl, (trade.exit - trade.entry) * trade.quantity * (trade.side === 'long' ? 1 : -1))
        || !almostEqual(trade.fees, trade.entryFee + trade.exit * trade.quantity * FEE_RATE)
        || !almostEqual(trade.pnl, trade.grossPnl - trade.fees)
        || trade.fees < 0 || !['manual', 'stop', 'target'].includes(trade.reason)
        || typeof trade.note !== 'string' || trade.note.length > 400 || trade.id >= state.nextId || ids.has(trade.id)) return null;
      ids.add(trade.id);
    }
    if (state.position && ids.has(state.position.id)) return null;
    if (state.trades.length < HISTORY_LIMIT && (state.trades.length === 0 || state.trades[0].id === 1)) {
      const expectedBalance = INITIAL_BALANCE + state.trades.reduce((sum, trade) => sum + trade.pnl, 0) - (state.position?.entryFee || 0);
      if (!almostEqual(state.balance, expectedBalance)) return null;
    }
    return state;
  } catch {
    return null;
  }
}
