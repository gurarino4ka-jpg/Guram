import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);
const script=new URL('../scripts/benchmark-candle-archive.mjs',import.meta.url);

test('synthetic archive benchmark produces validated metrics for a small run',async()=>{
  const {stdout}=await execFileAsync(process.execPath,[script.pathname,'12'],{
    timeout:30_000,maxBuffer:1024*1024,
  });
  const result=JSON.parse(stdout);
  assert.equal(result.syntheticCandles,12);
  assert.equal(result.batches,1);
  for (const key of ['appendMs','replayMs','journalBytes','heapUsedBytes']) {
    assert.equal(Number.isFinite(result[key]),true,key);
    assert.ok(result[key]>=0,key);
  }
  assert.ok(result.journalBytes>0);
});

test('synthetic benchmark suite reports independent runs',async()=>{
  const suite=new URL('../scripts/benchmark-candle-archive-suite.mjs',import.meta.url);
  const {stdout}=await execFileAsync(process.execPath,[suite.pathname,'3','7'],{
    timeout:30_000,maxBuffer:1024*1024,
  });
  const report=JSON.parse(stdout);
  assert.equal(report.kind,'synthetic-candle-archive-benchmark');
  assert.deepEqual(report.measurements.map(m=>m.syntheticCandles),[3,7]);
  assert.ok(report.measurements.every(m=>m.journalBytes>0));
});
