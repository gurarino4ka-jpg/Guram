# CandleArchive technical review (CA-01–CA-19)

Status: experimental, opt-in, branch-only. Do not merge or use as authoritative historical data until the gates below pass.

## Scope
- Schema validation, SHA-256 content hashes, revision chain, append-only checksummed JSONL batches.
- Read-only historical point-in-time retrieval via `getCandle({identity,openTimeMs,asOf})`.
- Optional collector hook and explicit CLI `--archive` switch.
- Existing monitor stays in `data-only` mode. No order execution or account integration.

## Verified by tests
- Warmup history and closed-bar filtering; unknown volume is null.
- Same candle does not create duplicate revision; corrections create new revisions.
- Committed batches replay after restart; incomplete trailing record fails closed.
- Corrupt batch checksum, changed candle values, and inconsistent observation time fail closed.
- A second archive writer is refused by lock file.

## Open risks / merge blockers
1. **Crash durability**: file and directory `fsync` are used on POSIX, but sudden power loss is not tested; directory sync is skipped on Windows. Simulated process-kill and power-loss tests have not been run. No automatic recovery of incomplete tails is implemented; manual inspection required.
2. **Lock ownership**: archive uses a separate lock file from the existing monitor. The token, PID, device and inode are checked before writes and release, but the check and subsequent operation are not atomic. Stale-lock recovery is manual.
3. **Market provenance**: CLI currently constructs conservative Bookflow identity from symbol conventions; this must be checked against verified response metadata before the archive can be treated as an authoritative source. Unknown market type and price basis must remain unknown.
4. **Journal integrity**: record hash covers selected revision metadata; outer batch checksum covers the complete batch, but is not a keyed signature or externally anchored hash chain. A fully rewritten journal cannot be authenticated.
5. **Query semantics**: `getCandle` uses `knownAtMs` and does not yet provide a bounded range API or observation-level audit trail for unchanged repeats.
6. **Backfill and migration**: historical gaps and existing monitor snapshots are not automatically migrated; historical market equivalence to exchange perpetuals is not established.
7. **Capacity**: journal replay is linear in full journal size; compaction/indexes and long-running load tests are absent.
8. **Review**: CI success is not a security review, integration soak test or production readiness certification.

## Merge gates
- Run all repository tests and inspect GitHub Actions on the latest commit.
- Add deterministic failure-injection tests for interrupted writes; lock replacement tests and manual recovery procedure exist.
- Confirm market identity against provider response, not inferred naming.
- Add bounded query and full CLI integration tests using fixtures. Collector + archive + store end-to-end fixture test exists.
- Independent code review; merge only after explicit approval.

## Manual recovery after a crash (no automatic lock removal)
1. Stop the monitor and ensure no other collector or archive process is writing to the same `dataDir`. A PID alone is not proof of process identity, especially across hosts and containers.
2. Back up the **entire** `archive/v1` directory, including `archive.lock` and `observations.jsonl`, before making changes.
3. Check the lock's PID, token, creation time and host/container context. Confirm that the owner is no longer alive and no other writer has acquired the archive. Do not remove a lock merely because it looks old.
4. Inspect the journal for incomplete or invalid lines. The reader deliberately refuses to open corrupt journals and **does not** truncate or repair them. Preserve original bytes and investigate before any offline repair.
5. Only after verifying that all writers are stopped, remove the stale lock **manually** and restart in a controlled environment. If the journal is corrupt, keep the archive offline until a separately reviewed recovery process is available.
6. Verify replay, revision counts and the latest point-in-time candle before resuming collection. Never use an unverified archive for historical strategy evaluation.

The current lock is advisory and not a cross-host distributed lease. A replacement between ownership check and write remains a race; use one writer and an isolated local filesystem.

## CA-11 update (2026-11-11)
- CI verified lock replacement regression; no live collection or trading.
- Archive directory fsync now follows journal append and lock creation/removal on supported POSIX systems.
- Matching tokens cannot bypass inode/device verification during the next ownership check.
- **Merge blocker:** TOCTOU remains between checking the lock and writing the journal. Advisory local locks are not distributed fencing.
- CI does not establish power-loss consistency or real exchange market provenance.

## CA-19 integration readiness assessment (2026-11-11)

**Decision: NO-GO for production trading or authoritative historical backtesting.** This is a test-only, opt-in archive on a feature branch. CI is a regression signal, not a durability or security certification.

### Verified in automated fixtures
- Interrupted JSONL tail fails closed; original committed prefix is preserved; offline recovery requires a backup and explicit operator intervention.
- Concurrent opens yield a single winner under the tested local filesystem conditions.
- Lost/replaced lock stops subsequent writes; the former owner does not delete the successor's lock.
- Close after lost ownership releases its own descriptor and disables stale reads.
- Symlinked journal and regular-file inode replacement are rejected before subsequent append operations.

### Blocking issues, in priority order
1. **Atomic ownership / TOCTOU:** lock verification and journal append are separate operations. An adversarial or uncoordinated writer can change paths between checks; no OS-level mandatory lock or distributed fencing token exists.
2. **Crash durability:** no process-kill/power-loss matrix across target operating systems and filesystems; Windows directory fsync is skipped. Offline journal recovery is manual.
3. **Market provenance:** provider identity, instrument type, quote/settlement assets and price basis require confirmation against authoritative provider metadata; do not infer perpetual-futures equivalence from ticker names.
4. **End-to-end operations:** add full CLI fixture and sustained workload/soak testing, including bounded historical queries and resource usage.
5. **Integrity and audit:** checksums are not authenticated against an independent trust anchor; journal rewrite by a privileged actor remains undetectable.
6. **Read lifecycle:** synchronous in-memory reads do not reverify external lock ownership at each call; consumers must not treat them as a multi-process snapshot guarantee.

### Next implementation gate
- Agree on single-writer deployment contract and target OS/filesystem before changing lock design.
- Add deterministic fault injection around open/append/sync/close with preservation-of-evidence assertions.
- Add full CLI fixture integration and capacity tests.
- Require independent review and explicit merge approval. Do not merge automatically.

No live market collection, order placement, demo-account changes or backtests were performed in CA-01–CA-19.
