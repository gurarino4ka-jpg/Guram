# UpScale demo readiness: read-only integration gate (CA-59)

**Status: NOT READY — NO-GO.** This is a checklist, not a claim that UpScale's private API, account, or order routes have been inspected. No account credentials or live requests are required or authorized.

## Official UpScale documentation confirmed (November 11, 2026)

- [Upscale Public API](https://docs.upscale.trade/developers) identifies
  `https://api.upscale.trade` as the API origin, `GET /accounts/with-risk-status`
  as the account listing endpoint, and `GET /v2/markets?accountId=...` as an
  account-scoped market lookup. Authentication is Bearer API key.
- Only accounts with API Trading enabled appear in API-key account lists.
  The documented API key **inherits the account owner's permissions**.
  No dedicated read-only key scope is established by these docs. A normal key
  may also authorize `POST /orders`; obtaining a key is **not** equivalent to
  enforcing read-only access. Never use order endpoints for this gate.
- API Trading can be activated on a demo challenge and changes account rules.
  The platform documents both a 60-second profitable-close adjustment and a
  30% maximum-profit-day rule, including on manual account operations.
- The provider-neutral `parseDemoAccountSnapshot` schema is **not** the
  UpScale API response schema. A documented, reviewed normalization step is
  still required. Do not claim real account readiness from mock test results.
- `npm run demo:verify` is an automated five-phase synthetic security gate.
  `npm run demo:smoke` is a standalone offline fixture, not a provider session.
  Both are credential-free and submit no orders.

## Existing verified scope

- The current market monitor supports `mode: "data-only"` only and rejects unknown configuration fields. It collects public BTC/ETH/SOL/ZEC quotes and closed candles; it does **not** log in, read private account balances, submit orders, or run strategies.
- The local browser simulator uses synthetic candles and virtual balances. Its orders are simulated in local browser storage, not routed to UpScale.
- CandleArchive v2 is experimental, not yet wired into the monitor's production data path. Passing unit/CI tests does not establish complete end-to-end readiness.
- CI uses synthetic fixtures; it is not proof of a live UpScale account integration.

## Required gates before read-only demo account connection

1. Obtain **official and current** UpScale documentation for the correct demo environment, API origin, authentication scheme, scopes, rate limits, and exact account/position/order endpoints. Do not infer routes from the website or third-party clients.
2. Create a separate adapter with a hardcoded, allowlisted HTTPS origin and **GET-only** request policy. Reject non-GET methods and redirect attempts; never forward credentials to a different origin.
3. Require a dedicated read-only credential with no order-placement, modification, withdrawal, or transfer permissions. If UpScale cannot provide read-only access, do not connect the account.
4. Keep secrets out of Git, logs, snapshots, browser localStorage and CI output. Use runtime-only secret injection and redact errors.
5. Validate all responses (account identity, demo vs live, balance currency, timestamps, instrument mapping, stale data, rate limits) and fail closed on ambiguity.
6. Add a transport mock that asserts **zero mutation requests** for every error, retry, timeout and malformed-response path. Explicitly test POST/PUT/PATCH/DELETE rejection.
7. Confirm the read-only adapter never imports or invokes the simulator's order-entry functions. Do not add an execution adapter as part of this gate.
8. Run isolated end-to-end tests with synthetic responses; independently review code and threat model.
9. Only after explicit authorization, verify a demo account using read-only operations. Do not request credentials in chat or access a live account.
10. Any future simulated or demo order execution requires a **separate explicit approval** and a separate design review, even if read-only checks pass.

## CandleArchive v2 independent release gates

- Verify published-chain integrity, crash recovery and cross-process lock behavior across supported operating systems.
- Benchmark 1k/5k/10k and 100k+ synthetic records; compare throughput, RSS, disk footprint and startup/audit latency to v1.
- Implement explicit, reviewed recovery/migration procedures without automatic orphan deletion.
- Integrate the new storage path behind an opt-in flag with full collector fixture tests.
- Obtain independent review and explicit permission before merging into `main`.

**Decision:** Do not enable private UpScale access or trading. No real-market collection or backtests are implied by this document.
