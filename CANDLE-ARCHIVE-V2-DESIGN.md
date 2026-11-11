# CA-38: Segmented CandleArchive journal — design proposal

**Status: design only, not implemented. Production remains NO-GO.**

## Problem

The current `archive/v1/observations.jsonl` is a single append-only JSONL file. CA-35/36 hashes the entire file before each append to detect same-size in-place tampering. With a fixed batch size, this makes total ingest verification work grow quadratically with batch count. Removing the check without a replacement is not acceptable.

## Proposed v2 layout

```text
archive/v2/
  archive.lock
  manifest.json
  segments/
    000000000001.jsonl
    000000000002.jsonl
    ...
  active.jsonl
```

The v1 directory must remain readable by the existing v1 implementation. No in-place upgrade, rename, or automatic migration. A separate explicit migration tool must be designed and tested later.

## Segment invariants

1. One writer owns the archive; no network filesystem, shared volume or adversarial writer is assumed safe. An external process with write permission can still subvert integrity unless an independently protected checkpoint is used.
2. Each JSONL observation retains its existing batch checksum and revision-chain validation. Every segment records its sequence number, byte length, batch count, first/last batch IDs and SHA-256 digest in the manifest.
3. Each sealed segment is immutable. The active segment has a fixed maximum byte budget (proposed initial value: 8 MiB, subject to benchmark) and is verified in full before each append. Sealed segments are verified at startup and by an independent periodic audit, not on every append.
4. Manifest entries form an ordered hash chain: `previousManifestHash` and `segmentHash` are included in the canonical manifest checksum. This detects accidental corruption, but **not** privileged rewriting of both manifest and data; an independently stored signed root/checkpoint is required for that threat.
5. All paths must be validated as regular files, with descriptor/path identity checks and exclusive creation; no symlink following. Segment numbers must be strictly consecutive; missing, duplicate, or unexpected segment files fail closed.
6. Revisions are applied only after journal data has been written and synced. A crash cannot result in a silently accepted incomplete batch, orphan segment, or partially published manifest.

## Publication and crash recovery protocol (to validate experimentally)

- Append to the active segment through a pinned descriptor; verify active segment length and content hash; write complete newline-terminated batch; `fsync` file; update in-memory revisions only after durability checks.
- When size limit is reached, seal active segment using a separately staged manifest and atomic rename **on the same filesystem**, then sync the containing directory. Never overwrite an existing numbered segment.
- Publication must be designed as a recoverable transaction: determine which file/manifest rename occurs first, and define explicit recovery for a crash after every individual write, sync, rename, and directory sync. Do not assume a multi-file rename is atomic.
- On restart, verify manifest, all sealed segments and active segment, then replay all batches in strict order. A mismatch fails closed and preserves all evidence. Operator-approved recovery must use a backup, not silent truncation.
- On Windows, directory fsync support and rename semantics need explicit validation. No cross-platform durability claim until tested.

## Required acceptance tests

- Rotation at exactly the size boundary; repeated rotations; no missing or duplicated revisions.
- Restart after every fault-injection point, including manifest staging, segment sealing and directory sync.
- In-place same-length edits, truncation, external append, symlink swaps and replacement of sealed and active segments.
- Manifest rewrite, segment reordering, missing and orphaned segments, and broken hash chain.
- Concurrent opens and ownership loss during rotation; stale lock handling.
- 1k/5k/10k comparison with v1 and 100k+ synthetic workload, including peak RSS, disk usage, restart latency and periodic audit duration.
- End-to-end CLI collection fixture; provenance metadata checks and explicit manual recovery procedure.

## Decision gates

1. Review the threat model and single-writer deployment contract.
2. Implement v2 in new modules and tests **without modifying v1 data on disk**.
3. Validate crash matrix and 100k+ performance before deciding on any migration.
4. Require independent review and explicit approval before merging to `main` or using real market data.

**No trading, no backtesting and no live collection are authorized by this proposal.**
