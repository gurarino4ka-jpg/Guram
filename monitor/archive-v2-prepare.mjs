import { SegmentManifestError } from './archive-v2-manifest.mjs';
import { readHead } from './archive-v2-head.mjs';
import { readVersionedManifest,writeVersionedManifest } from './archive-v2-generations.mjs';
import { validateHeadTransition } from './archive-v2-transition.mjs';

// Prepare an unpublished immutable generation under an externally acquired
// exclusive writer lock. HEAD is deliberately NOT changed here.
export async function prepareV2Generation(root,lock,nextManifest) {
  if(!lock||typeof lock.assertOwned!=='function') {
    throw new SegmentManifestError('Writer lock required');
  }
  await lock.assertOwned();
  const head=await readHead(root);
  const previous=await readVersionedManifest(root,head.generation);
  const expected=validateHeadTransition(head,nextManifest,previous);
  await lock.assertOwned();
  await writeVersionedManifest(root,nextManifest);
  await lock.assertOwned();
  const unchanged=await readHead(root);
  if(unchanged.generation!==head.generation||unchanged.manifestHash!==head.manifestHash) {
    throw new SegmentManifestError('HEAD changed while preparing generation');
  }
  return expected;
}
