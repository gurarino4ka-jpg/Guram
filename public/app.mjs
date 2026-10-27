import {
  createSession, restoreSession, currentPrice, openPosition, closePosition,
  nextCandle, unrealizedPnl, equity, updateNote, FEE_RATE,
} from './domain.mjs';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'tradelab.practice.v1';
const priceFormat = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quantityFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 });
const money = value => `${priceFormat.format(value)} $`;
const signedMoney = value => `${value > 0 ? '+' : ''}${money(value)}`;
let state;
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  state = raw ? restoreSession(raw) : createSession();
  if (!state) {
    state = createSession();
    $('storage-status').textContent = 'Не удалось восстановить сохранённую сессию. Создан новый учебный счёт.';
  }
} catch {
  state = createSession();
  $('storage-status').textContent = 'Сохранение в браузере недоступно. Практика работает, но сессия исчезнет после перезагрузки.';
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    $('storage-status').textContent = 'Не удалось сохранить сессию. Не закрывайте вкладку, если хотите продолжить текущую практику.';
  }
}

function setTone(element, value) {
  element.classList.toggle('positive', value > 0);
  element.classList.toggle('negative', value < 0);
}

function selectedSide() {
  return document.querySelector('input[name="side"]:checked').value;
}

function defaultLevels() {
  const price = currentPrice(state);
  const long = selectedSide() === 'long';
  $('stop').value = (price * (long ? .98 : 1.02)).toFixed(2);
  $('target').value = (price * (long ? 1.04 : .96)).toFixed(2);
  $('order-error').textContent = '';
  renderOrderSummary();
}

function renderOrderSummary() {
  const quantity = Number($('quantity').value);
  const stop = Number($('stop').value);
  const price = currentPrice(state);
  const notional = quantity * price;
  const entryFee = notional * FEE_RATE;
  const risk = Math.abs(price - stop) * quantity + entryFee + stop * quantity * FEE_RATE;
  const valid = Number.isFinite(notional) && quantity > 0;
  $('order-notional').textContent = valid ? money(notional) : '—';
  $('order-fee').textContent = valid ? money(entryFee) : '—';
  $('order-risk').textContent = valid && Number.isFinite(risk) && stop > 0 ? money(risk) : '—';
  $('open-position').textContent = selectedSide() === 'long' ? 'Открыть покупку ↗' : 'Открыть продажу ↘';
}

function render() {
  const price = currentPrice(state);
  const lastCandle = state.candles.at(-1);
  const previousPrice = state.candles.at(-2).close;
  const change = (price / previousPrice - 1) * 100;
  const totalPnl = equity(state) - state.initialBalance;
  $('balance').textContent = money(state.balance);
  $('equity').textContent = money(equity(state));
  $('total-pnl').textContent = signedMoney(totalPnl);
  setTone($('total-pnl'), totalPnl);
  $('trade-count').textContent = state.trades.length;
  const wins = state.trades.filter(trade => trade.pnl > 0).length;
  $('win-rate').textContent = state.trades.length ? `${Math.round(wins / state.trades.length * 100)}% прибыльных в журнале` : 'Собираем первый опыт';
  $('last-price').textContent = money(price);
  $('price-change').textContent = `${change >= 0 ? '+' : ''}${priceFormat.format(change)}% за свечу`;
  setTone($('price-change'), change);
  $('candle-index').textContent = lastCandle.index + 1;
  for (const key of ['open', 'high', 'low', 'close']) $('candle-' + key).textContent = priceFormat.format(lastCandle[key]);
  $('market-chart').setAttribute('aria-label', `Свечной график DEMO / USD. Текущая цена ${money(price)}. Свеча ${lastCandle.index + 1}. Открытие ${lastCandle.open}, максимум ${lastCandle.high}, минимум ${lastCandle.low}, закрытие ${lastCandle.close}.`);
  $('order-form').hidden = Boolean(state.position);
  $('position-card').hidden = !state.position;
  $('order-heading').textContent = state.position ? 'Открытая позиция' : 'План сделки';
  if (state.position) {
    const position = state.position;
    $('position-side').textContent = position.side === 'long' ? '↗ Покупка открыта' : '↘ Продажа открыта';
    $('position-entry').textContent = money(position.entry);
    $('position-quantity').textContent = `${quantityFormat.format(position.quantity)} DEMO`;
    $('position-levels').textContent = `${priceFormat.format(position.stop)} / ${priceFormat.format(position.target)}`;
    $('position-pnl').textContent = signedMoney(unrealizedPnl(state));
    setTone($('position-pnl'), unrealizedPnl(state));
  }
  renderOrderSummary();
  renderJournal();
  drawChart();
}

function cell(row, text, className) {
  const td = document.createElement('td');
  if (text !== undefined) td.textContent = text;
  if (className) td.className = className;
  row.append(td);
  return td;
}

function renderJournal() {
  const filter = $('journal-filter').value;
  const trades = state.trades.filter(trade => filter === 'all' || (filter === 'profit' ? trade.pnl > 0 : trade.pnl < 0));
  $('journal-empty').hidden = trades.length > 0;
  $('journal-table-wrap').hidden = trades.length === 0;
  if (!trades.length) {
    $('journal-empty').querySelector('h3').textContent = state.trades.length ? 'В этом фильтре пока нет сделок' : 'Каждая сделка — это урок';
    $('journal-empty').querySelector('p').textContent = state.trades.length ? 'Выберите «Все сделки», чтобы вернуться к истории.' : 'Закройте первую позицию, и здесь появятся результат, комиссии и место для ваших выводов.';
  }
  const fragment = document.createDocumentFragment();
  for (const trade of [...trades].reverse()) {
    const row = document.createElement('tr');
    const sideCell = cell(row);
    const direction = document.createElement('span');
    direction.className = `trade-direction ${trade.side === 'short' ? 'short' : ''}`;
    direction.textContent = `${trade.side === 'long' ? '↗ Покупка' : '↘ Продажа'} #${trade.id}`;
    sideCell.append(direction);
    const steps = document.createElement('small');
    steps.textContent = `Свечи ${trade.openedAt + 1} → ${trade.closedAt + 1}`;
    sideCell.append(steps);
    cell(row, `${priceFormat.format(trade.entry)} → ${priceFormat.format(trade.exit)}`);
    cell(row, quantityFormat.format(trade.quantity));
    cell(row, money(trade.fees));
    cell(row, signedMoney(trade.pnl), trade.pnl > 0 ? 'positive' : trade.pnl < 0 ? 'negative' : '');
    cell(row, ({ manual: 'Вручную', stop: 'Стоп-лосс', target: 'Тейк-профит' })[trade.reason]);
    const noteCell = cell(row);
    const note = document.createElement('textarea');
    note.className = 'note-input';
    note.maxLength = 400;
    note.rows = 2;
    note.placeholder = 'Что я понял из сделки?';
    note.setAttribute('aria-label', `Вывод по сделке ${trade.id}`);
    note.value = trade.note;
    note.addEventListener('input', () => {
      state = updateNote(state, trade.id, note.value);
      save();
    });
    noteCell.append(note);
    fragment.append(row);
  }
  $('journal-body').replaceChildren(fragment);
}

function drawChart() {
  const canvas = $('market-chart');
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.scale(ratio, ratio);
  const width = rect.width;
  const height = rect.height;
  const left = 7, right = 65, top = 17, bottom = 26;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const candles = state.candles.slice(-Math.max(20, Math.min(54, Math.floor(plotWidth / 9))));
  let high = Math.max(...candles.map(candle => candle.high));
  let low = Math.min(...candles.map(candle => candle.low));
  const padding = Math.max((high - low) * .12, .5);
  high += padding;
  low -= padding;
  const y = price => top + (high - price) / (high - low) * plotHeight;
  context.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  context.textBaseline = 'middle';
  for (let line = 0; line <= 4; line += 1) {
    const value = low + (high - low) * line / 4;
    const at = y(value);
    context.strokeStyle = '#253040';
    context.lineWidth = .6;
    context.beginPath(); context.moveTo(left, at); context.lineTo(width - right + 2, at); context.stroke();
    context.fillStyle = '#71849b';
    context.fillText(priceFormat.format(value), width - right + 9, at);
  }
  const slot = plotWidth / candles.length;
  candles.forEach((candle, index) => {
    const x = left + slot * index + slot / 2;
    const bullish = candle.close >= candle.open;
    context.strokeStyle = bullish ? '#b9e778' : '#ed8291';
    context.fillStyle = bullish ? '#b9e778' : '#ed8291';
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(x, y(candle.high)); context.lineTo(x, y(candle.low)); context.stroke();
    const bodyWidth = Math.max(3, Math.min(8, slot * .62));
    context.fillRect(x - bodyWidth / 2, Math.min(y(candle.open), y(candle.close)), bodyWidth, Math.max(1, Math.abs(y(candle.close) - y(candle.open))));
    if (index % Math.max(1, Math.floor(candles.length / 5)) === 0) {
      context.fillStyle = '#64778f';
      context.textAlign = 'center';
      context.fillText(String(candle.index + 1), x, height - 9);
      context.textAlign = 'left';
    }
  });
  const price = currentPrice(state);
  context.setLineDash([3, 4]);
  context.lineWidth = .8;
  context.strokeStyle = '#b9e77888';
  context.beginPath(); context.moveTo(left, y(price)); context.lineTo(width - right + 5, y(price)); context.stroke();
  context.setLineDash([]);
  const labelWidth = right - 5;
  context.fillStyle = '#c3f36b';
  context.fillRect(width - right + 5, y(price) - 9, labelWidth, 18);
  context.fillStyle = '#1b2417';
  context.font = 'bold 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  context.fillText(priceFormat.format(price), width - right + 9, y(price));
  if (state.position) {
    for (const [level, label, color] of [[state.position.entry, 'ВХОД', '#8ac7ef'], [state.position.stop, 'СТОП', '#ff8a95'], [state.position.target, 'ЦЕЛЬ', '#c3f36b']]) {
      const actualY = y(level);
      const at = Math.max(top + 8, Math.min(top + plotHeight - 8, actualY));
      context.strokeStyle = color + '99';
      context.fillStyle = color;
      context.setLineDash([5, 5]);
      context.beginPath(); context.moveTo(left, at); context.lineTo(width - right, at); context.stroke();
      context.setLineDash([]);
      context.font = '8px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      context.fillText(`${label}${actualY < at ? ' ↑' : actualY > at ? ' ↓' : ''} ${priceFormat.format(level)}`, left + 5, at - 7);
    }
  }
}

$('order-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    state = openPosition(state, {
      side: selectedSide(), quantity: Number($('quantity').value),
      stop: Number($('stop').value), target: Number($('target').value),
    });
    save();
    $('order-error').textContent = '';
    $('action-status').textContent = `Позиция #${state.position.id} открыта по ${money(state.position.entry)}. Перейдите к следующей свече или закройте позицию вручную.`;
    render();
    $('close-position').focus({ preventScroll: true });
  } catch (error) {
    $('order-error').textContent = error.message;
  }
});

$('next-candle').addEventListener('click', () => {
  const previousPosition = state.position;
  state = nextCandle(state);
  save();
  if (previousPosition && !state.position) {
    const trade = state.trades.at(-1);
    $('action-status').textContent = `Позиция #${trade.id} закрыта: ${trade.reason === 'stop' ? 'стоп-лосс' : 'тейк-профит'}. Результат с комиссиями: ${signedMoney(trade.pnl)}. Добавьте вывод в журнал.`;
    defaultLevels();
  } else {
    $('action-status').textContent = `Свеча ${state.candles.at(-1).index + 1}. Цена ${money(currentPrice(state))}.${state.position ? ` Открытый результат: ${signedMoney(unrealizedPnl(state))} до комиссии за выход.` : ' Сравните новую цену с вашим планом сделки.'}`;
  }
  render();
});

$('close-position').addEventListener('click', () => {
  state = closePosition(state);
  const trade = state.trades.at(-1);
  save();
  $('action-status').textContent = `Позиция #${trade.id} закрыта вручную. Результат с комиссиями: ${signedMoney(trade.pnl)}. Что вы заметили? Запишите в журнал.`;
  defaultLevels();
  render();
  $('open-position').focus({ preventScroll: true });
});

for (const input of document.querySelectorAll('input[name="side"]')) input.addEventListener('change', defaultLevels);
for (const id of ['quantity', 'stop', 'target']) $(id).addEventListener('input', renderOrderSummary);
$('journal-filter').addEventListener('change', renderJournal);
$('reset-session').addEventListener('click', () => $('reset-dialog').showModal());
$('cancel-reset').addEventListener('click', () => $('reset-dialog').close());
$('confirm-reset').addEventListener('click', () => {
  state = createSession();
  $('journal-filter').value = 'all';
  $('quantity').value = '8';
  document.querySelector('input[name="side"][value="long"]').checked = true;
  save();
  defaultLevels();
  render();
  $('reset-dialog').close();
  $('action-status').textContent = 'Новая сессия. У вас 10 000 виртуальных $. Начните с плана сделки.';
});

if ('ResizeObserver' in window) new ResizeObserver(drawChart).observe($('market-chart').parentElement);
else window.addEventListener('resize', drawChart);
defaultLevels();
render();
