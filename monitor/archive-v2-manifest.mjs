import { createHash } from 'node:crypto';

export class SegmentManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SegmentManifestError';
  }
}

const fail = message => { throw new SegmentManifestError(message); };
const sha = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const own = (obj,key) => Object.prototype.hasOwnProperty.call(obj,key);

export function segmentName(number) {
  if (!Number.isSafeInteger(number) || number < 1 || number > 999999999999) {
    fail('Invalid segment number');
  }
  return String(number).padStart(12,'0')+'.jsonl';
}

export function createSegmentDescriptor(number,content) {
  if (typeof content !== 'string' || !content.endsWith('\n')) fail('Segment must end with newline');
  if (!content.length) fail('Empty segment');
  const lines=content.slice(0,-1).split('\n');
  for (const line of lines) {
    if (!line.length) fail('Blank segment line');
    try { JSON.parse(line); } catch { fail('Invalid segment JSONL'); }
  }
  return Object.freeze({
    number,
    file:segmentName(number),
    bytes:Buffer.byteLength(content,'utf8'),
    batches:lines.length,
    sha256:sha(content),
  });
}

export function createSegmentManifest(descriptors) {
  if (!Array.isArray(descriptors)) fail('Segments must be an array');
  const segments=descriptors.map((descriptor,index)=>{
    if (!descriptor || typeof descriptor!=='object' || Array.isArray(descriptor) ||
        Object.keys(descriptor).sort().join(',')!=='batches,bytes,file,number,sha256' ||
        descriptor.number!==index+1 || descriptor.file!==segmentName(index+1) ||
        !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes<1 ||
        !Number.isSafeInteger(descriptor.batches) || descriptor.batches<1 ||
        !hex(descriptor.sha256)) fail('Invalid segment descriptor');
    return {...descriptor};
  });
  const payload={version:2,segments};
  return {...payload,checksum:sha(JSON.stringify(payload))};
}

export function verifySegmentManifest(manifest,contents) {
  if (!manifest || typeof manifest!=='object' || Array.isArray(manifest) ||
      Object.keys(manifest).sort().join(',')!=='checksum,segments,version' ||
      manifest.version!==2 || !hex(manifest.checksum) ||
      !Array.isArray(manifest.segments) ||
      !contents || typeof contents!=='object' || Array.isArray(contents)) fail('Invalid manifest');
  const expected=createSegmentManifest(manifest.segments);
  if (expected.checksum!==manifest.checksum) fail('Manifest checksum mismatch');
  if (Object.keys(contents).length!==manifest.segments.length) fail('Missing or unexpected segment');
  for (const descriptor of manifest.segments) {
    if (!own(contents,descriptor.file) || typeof contents[descriptor.file]!=='string') {
      fail('Missing segment');
    }
    const verified=createSegmentDescriptor(descriptor.number,contents[descriptor.file]);
    if (verified.bytes!==descriptor.bytes || verified.batches!==descriptor.batches ||
        verified.sha256!==descriptor.sha256) fail('Segment content mismatch');
  }
  return true;
}
