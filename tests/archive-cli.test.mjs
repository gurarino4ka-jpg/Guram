import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../monitor/cli.mjs';

test('archive is disabled by default',()=>{
  assert.equal(parseArgs([]).archive,false);
});
test('archive requires explicit --archive flag',()=>{
  const args=parseArgs(['--once','--archive']);
  assert.equal(args.once,true);
  assert.equal(args.archive,true);
});
test('unknown archive options fail closed',()=>{
  assert.throws(()=>parseArgs(['--archive=1']),/Unknown argument/);
});
