# CA-42 — v2 rotation transaction protocol (design gate)

**Scope:** offline prototype only. No migration of v1 archives, no live ingestion and no production deployment. The existing `publishInitialManifest` handles **only** first publication; it is not a rotation implementation.

## Transaction boundaries

A multi-file rotation cannot be made atomic by one rename. A crash between segment creation and manifest publication must be explicitly handled. The initial proposal below uses **immutable, versioned manifests** and a single small commit pointer, rather than overwriting `manifest.json` in place.

Proposed layout:

```text
archive/v2/
  archive.lock
  HEAD                  # generation + manifest SHA-256; atomic replace of one file
  manifests/
    000000000001.json   # immutable, exclusively created
    000000000002.json
  segments/
    000000000001.jsonl  # immutable, exclusively created
    000000000002.jsonl
  active.jsonl          # future append protocol, not designed here
```

**Compatibility:** this is a proposed evolution of the CA-39–41 initial-manifest prototype, which currently writes `manifest.json`. Do not treat that prototype as a compatible on-disk v2 format. Choose and freeze one format before any migration tool is developed.

## Proposed ordering

1. Verify exclusive writer lock and current HEAD generation, then verify every referenced sealed segment against its descriptor. No writer may mutate sealed segments.
2. Create the next numbered segment with `O_EXCL`; write and sync it; sync the segments directory. Never overwrite an existing segment.
3. Construct next manifest with strictly consecutive segments and a `previousManifestHash` link. Create `manifests/<next>.json` with `O_EXCL`, write/sync file, then sync directory.
4. Create a uniquely named staging HEAD file with `O_EXCL`, containing the new generation and manifest hash. Write/sync it. Atomically rename it to `HEAD` **on the same filesystem**, then sync archive root directory. This is the only logical commit point.
5. Report success only after the commit pointer and directory sync succeed. Update in-memory state after durability checks, not before.
6. On restart, read the committed HEAD via a pinned descriptor, validate the selected manifest and entire segment chain, and reject missing or corrupted committed data.

## Crash-state table

| Crash point | Expected restart behavior |
| --- | --- |
| Before new segment creation | Previous HEAD remains authoritative |
| During new segment write | Previous HEAD remains authoritative; incomplete unreferenced file preserved for manual recovery |
| After segment fsync, before manifest creation | Previous HEAD remains authoritative; unreferenced segment flagged |
| During manifest write | Previous HEAD remains authoritative; incomplete unreferenced manifest flagged |
| After manifest fsync, before HEAD staging | Previous HEAD remains authoritative; unpublished manifest flagged |
| During staged HEAD write | Previous HEAD remains authoritative; staging file flagged |
| After staged HEAD fsync, before rename | Previous HEAD remains authoritative; staged file flagged |
| After HEAD rename, before root directory sync | **Durability uncertain** after power loss; on restart validate whichever HEAD is present, never infer success from an orphan manifest |
| After root directory sync | New HEAD is authoritative, subject to successful integrity verification |

**Fail-closed rule:** unexpected orphan files, duplicate generations, missing segments, broken manifest hash chain or ambiguous HEAD cause an error and require operator inspection. Do not silently delete or truncate evidence.

## Integrity limitations

SHA-256 and linked manifests detect accidental corruption, but a privileged actor who can rewrite HEAD and every manifest can forge a new internally consistent history. An independent, protected checkpoint is needed to defend against this threat. Lock checks alone do not eliminate TOCTOU races against a non-cooperating writer. Windows rename and directory-sync semantics need target-environment validation.

## Tests required before implementation is accepted

- Fault injection at every write, fsync, rename and directory sync; restart after each interruption.
- Repeated rotations; exact boundary behavior; no gaps or duplicates in segment numbers or candle revisions.
- Unreferenced and truncated files fail closed without evidence destruction.
- HEAD replacement, symlink substitution, concurrent rotation and lock loss.
- Cross-platform Node 22/24 + Windows tests, then 100k+ synthetic performance and crash durability trials.

**Gate:** No rotation implementation is approved until the HEAD-based layout is reviewed and the legacy `manifest.json` prototype's status is resolved. Production remains NO-GO.
