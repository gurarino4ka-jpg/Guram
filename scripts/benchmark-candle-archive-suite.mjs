import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync=promisify(execFile);
const script=fileURLToPath(new URL('./benchmark-candle-archive.mjs',import.meta.url));
const counts=process.argv.slice(2).filter(arg=>!arg.startsWith('--'));
const repeatFlag=process.argv.slice(2).find(arg=>arg.startsWith('--repeats='));
const repeats=repeatFlag?Number(repeatFlag.slice('--repeats='.length)):1;
if (!Number.isSafeInteger(repeats)||repeats<1||repeats>10) {
  throw new Error('Repeat count must be an integer from 1 to 10');
}
function percentile(sorted,p) {
  return sorted[Math.ceil(sorted.length*p)-1];
}
function summarize(values) {
  const sorted=[...values].sort((a,b)=>a-b);
  return {median:percentile(sorted,0.5),p95:percentile(sorted,0.95),min:sorted[0],max:sorted.at(-1)};
}
const sizes=counts.length?counts.map(Number):[1000,5000,10000];
if (sizes.some(n=>!Number.isSafeInteger(n)||n<1||n>10000)) {
  throw new Error('Usage: node scripts/benchmark-candle-archive-suite.mjs [counts...] [--output=path]');
}
const outputFlag=process.argv.slice(2).find(arg=>arg.startsWith('--output='));
const output=outputFlag?.slice('--output='.length);
if (outputFlag && !output) throw new Error('Output path is empty');
const runs=[];
for (const count of sizes) {
  const trials=[];
  for (let trial=0;trial<repeats;trial++) {
    const {stdout}=await execFileAsync(process.execPath,[script,String(count)],{
      timeout:180_000,maxBuffer:1024*1024,
    });
    const metrics=JSON.parse(stdout);
    if (metrics.syntheticCandles!==count ||
        ['appendMs','replayMs','journalBytes','heapUsedBytes'].some(key=>
          !Number.isFinite(metrics[key])||metrics[key]<0)) {
      throw new Error('Benchmark returned invalid metrics for '+count);
    }
    trials.push(metrics);
  }
  if (repeats===1) runs.push(trials[0]);
  else runs.push({syntheticCandles:count,trials,
    appendMs:summarize(trials.map(x=>x.appendMs)),
    replayMs:summarize(trials.map(x=>x.replayMs)),
    journalBytes:summarize(trials.map(x=>x.journalBytes)),
    heapUsedBytes:summarize(trials.map(x=>x.heapUsedBytes))});
}
const report={kind:'synthetic-candle-archive-benchmark',node:process.version,
  platform:process.platform,arch:process.arch,repeats,measurements:runs};
const json=JSON.stringify(report,null,2)+'\n';
if (output) {
  await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});
  await fs.writeFile(output,json,{flag:'wx'});
}
process.stdout.write(json);
