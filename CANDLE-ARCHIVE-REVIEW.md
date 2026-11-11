# CandleArchive technical review (CA-01–CA-04)

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
1. **Crash durability**: file `fsync` is used, but archive directory metadata is not synced on POSIX. Simulated process-kill and power-loss tests have not been run. No automatic recovery of incomplete tails is implemented; manual inspection required.
2. **Lock ownership**: archive uses a separate lock file from the existing monitor. The lock does not have a verified token/ownership check at every write and stale-lock recovery is manual.
3. **Market provenance**: CLI currently constructs conservative Bookflow identity from symbol conventions; this must be checked against verified response metadata before the archive can be treated as an authoritative source. Unknown market type and price basis must remain unknown.
4. **Journal integrity**: record hash covers selected revision metadata; outer batch checksum covers the complete batch, but is not a keyed signature or externally anchored hash chain. A fully rewritten journal cannot be authenticated.
5. **Query semantics**: `getCandle` uses `knownAtMs` and does not yet provide a bounded range API or observation-level audit trail for unchanged repeats.
6. **Backfill and migration**: historical gaps and existing monitor snapshots are not automatically migrated; historical market equivalence to exchange perpetuals is not established.
7. **Capacity**: journal replay is linear in full journal size; compaction/indexes and long-running load tests are absent.
8. **Review**: CI success is not a security review, integration soak test or production readiness certification.

## Merge gates
- Run all repository tests and inspect GitHub Actions on the latest commit.
- Add failure-injection tests for interrupted write/lock ownership; document recovery procedure.
- Confirm market identity against provider response, not inferred naming.
- Add bounded query and end-to-end collector/CLI tests using fixtures.
- Independent code review; merge only after explicit approval.
