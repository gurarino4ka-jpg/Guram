import test from 'node:test';
import assert from 'node:assert/strict';
import { runV2ProcessCrashProbe } from './archive-v2-process-crash-helper.mjs';

for(const boundary of ['after-stage-sync','before-rename','after-rename','after-directory-sync']) {
  test('v2 SIGKILL child process at '+boundary,{
    skip:process.platform==='win32'?'POSIX SIGKILL semantics required':false,
  },async()=>{
    const result=await runV2ProcessCrashProbe('kill-'+boundary);
    assert.equal(result.generation,result.expectedGeneration);
    assert.equal(result.requiresOperatorReview,true);
    if(result.generation===1) {
      assert.deepEqual(result.orphanManifests,['000000000002.json']);
    } else {
      assert.deepEqual(result.orphanManifests,[]);
    }
  });
}
