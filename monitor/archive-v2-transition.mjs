import { SegmentManifestError } from './archive-v2-manifest.mjs';
import { validateHead } from './archive-v2-head.mjs';
import { verifyVersionedManifest } from './archive-v2-generations.mjs';

// Pure transition validation. No disk mutation, locking or atomic CAS is implied.
export function validateHeadTransition(currentHead,nextManifest,previousManifest) {
  validateHead(currentHead);
  verifyVersionedManifest(previousManifest);
  verifyVersionedManifest(nextManifest);
  if(currentHead.generation!==previousManifest.generation ||
      currentHead.manifestHash!==previousManifest.manifestHash) {
    throw new SegmentManifestError('Current HEAD does not match previous manifest');
  }
  if(nextManifest.generation!==currentHead.generation+1 ||
      nextManifest.previousHash!==currentHead.manifestHash) {
    throw new SegmentManifestError('Invalid generation transition');
  }
  if(nextManifest.segments.length<=previousManifest.segments.length) {
    throw new SegmentManifestError('Transition must append sealed segments');
  }
  for(let i=0;i<previousManifest.segments.length;i++) {
    if(JSON.stringify(nextManifest.segments[i])!==JSON.stringify(previousManifest.segments[i])) {
      throw new SegmentManifestError('Transition modifies sealed history');
    }
  }
  return {generation:nextManifest.generation,manifestHash:nextManifest.manifestHash};
}
