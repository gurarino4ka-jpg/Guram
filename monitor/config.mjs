import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SUPPORTED_RESOLUTIONS } from './core.mjs';

export const SYMBOLS = Object.freeze(['BTC', 'ETH', 'SOL', 'ZEC']);
const fields = ['mode', 'symbols', 'resolutions', 'pollSeconds', 'countback', 'timeoutSeconds', 'maxQuoteAgeSeconds', 'maxClosedLagPeriods', 'dataDir'];

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be an object.');
  if (Object.keys(input).some(key => !fields.includes(key))) throw new Error('Unknown configuration field.');
  if (input.mode !== 'data-only') throw new Error('Only data-only mode is implemented.');
  for (const [field, allowed] of [['symbols', SYMBOLS], ['resolutions', SUPPORTED_RESOLUTIONS]]) {
    const values = input[field];
    if (!Array.isArray(values) || !values.length || values.some(value => !allowed.includes(value)) || new Set(values).size !== values.length) {
      throw new Error(`Invalid ${field}.`);
    }
  }
  for (const [key, min, max] of [['pollSeconds', 30, 3600], ['countback', 50, 500], ['timeoutSeconds', 2, 60], ['maxQuoteAgeSeconds', 15, 600], ['maxClosedLagPeriods', 1, 3]]) {
    if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw new Error(`Invalid ${key}: expected integer ${min}–${max}.`);
  }
  if (typeof input.dataDir !== 'string' || !input.dataDir.trim() || input.dataDir.includes('\0')) throw new Error('Invalid dataDir.');
  return { ...input, symbols: [...input.symbols], resolutions: [...input.resolutions] };
}

export async function loadConfig(path, { dataDir } = {}) {
  const file = resolve(path);
  const config = validateConfig(JSON.parse(await readFile(file, 'utf8')));
  return { ...config, dataDir: dataDir ? resolve(dataDir) : resolve(dirname(file), config.dataDir) };
}
