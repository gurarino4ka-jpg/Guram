import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.mjs';
import { createBookflowProvider } from './provider.mjs';
import { createStore } from './store.mjs';
import { collectOnce } from './collector.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(args) {
  const result = { once: false, help: false, config: resolve(root, 'monitor.config.json') };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--once') result.once = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--config' || arg === '--data-dir') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      result[arg === '--config' ? 'config' : 'dataDir'] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

export async function main(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Для мониторинга нужен Node.js 24 LTS или новее.');
  const options = parseArgs(args);
  if (options.help) {
    console.log('Локальный сборщик данных: node monitor/cli.mjs [--once] [--config PATH] [--data-dir PATH]\nРежим data-only: котировки, закрытые свечи и журнал. Торговых функций нет.');
    return;
  }
  const config = await loadConfig(options.config, { dataDir: options.dataDir });
  const store = await createStore(config.dataDir);
  await store.acquireLock();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let lastStatus;
  try {
    let state = await store.readState();
    const provider = createBookflowProvider({ timeoutMs: config.timeoutSeconds * 1000 });
    console.log(`Сбор данных: ${config.symbols.join(', ')}; таймфреймы ${config.resolutions.join(', ')}; интервал ${config.pollSeconds} с.`);
    console.log(`Журнал и состояние: ${config.dataDir}\nРежим: только данные. Подключения к счёту и торговых заявок нет. Остановка: Ctrl+C.`);
    while (!controller.signal.aborted) {
      const startedAt = Date.now();
      const result = await collectOnce({ provider, store, config, previousState: state, signal: controller.signal });
      state = result.state;
      lastStatus = result.status;
      const prices = lastStatus.quotes.map(quote => `${quote.symbol} ${quote.price.toLocaleString('ru-RU', { maximumFractionDigits: 5 })}${quote.stale ? ' (устарело)' : ''}`).join(' | ');
      console.log(`[${lastStatus.checkedAt}] ${lastStatus.health.toUpperCase()} ${lastStatus.completedStreams}/${lastStatus.expectedStreams} потоков; новых записей: ${lastStatus.appendedEvents}${prices ? ` | ${prices}` : ''}`);
      for (const issue of lastStatus.issues) console.log(`  ${issue.stream}: ${issue.code}${issue.httpStatus ? ` HTTP ${issue.httpStatus}` : ''}`);
      if (options.once) { process.exitCode = lastStatus.health === 'ok' ? 0 : 1; break; }
      const waitMs = Math.max(config.pollSeconds * 1000 - (Date.now() - startedAt), result.retryAfterMs);
      await delay(Math.max(0, waitMs), undefined, { signal: controller.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
    }
  } finally {
    try {
      if (lastStatus) await store.writeStatus({ ...lastStatus, running: false, stoppedAt: new Date().toISOString() });
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await store.releaseLock();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Монитор остановлен: ${error.message}`); process.exitCode = 1; });
}
