import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync=promisify(execFile);
const script=fileURLToPath(new URL('./benchmark-candle-archive.mjs',import.meta.url));
const counts=process.argv.slice(2).filter(arg=>!arg.startsWith('--'));
const sizes=counts.length?counts.map(Number):[1000,5000,10000];
if (sizes.some(n=>!Number.isSafeInteger(n)||n<1||n>10000)) {
  throw new Error('Usage: node scripts/benchmark-candle-archive-suite.mjs [counts...] [--output=path]');
}
const outputFlag=process.argv.slice(2).find(arg=>arg.startsWith('--output='));
const output=outputFlag?.slice('--output='.length);
if (outputFlag && !output) throw new Error('Output path is empty');
const runs=[];
for (const count of sizes) {
  const {stdout}=await execFileAsync(process.execPath,[script,String(count)],{
    timeout:180_000,maxBuffer:1024*1024,
  });
  const metrics=JSON.parse(stdout);
  if (metrics.syntheticCandles!==count || !Number.isFinite(metrics.appendMs) ||
      !Number.isFinite(metrics.replayMs) || !Number.isFinite(metrics.journalBytes)) {
    throw new Error('Benchmark returned invalid metrics for '+count);
  }
  runs.push(metrics);
}
const report={kind:'synthetic-candle-archive-benchmark',node:process.version,
  platform:process.platform,arch:process.arch,measurements:runs};
const json=JSON.stringify(report,null,2)+'\n';
if (output) {
  await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});
  await fs.writeFile(output,json,{flag:'wx'});
}
process.stdout.write(json);
