# Architecture — Distributed Wagering Processor

## Goal

Process wagering operations from multiple game providers with **financial correctness** under at-least-once delivery, out-of-order messages, and multi-instance concurrency.

## Stack decisions

| Choice | Why |
|--------|-----|
| **Bun** | Required runtime / package manager / test runner |
| **NestJS** | Modular DI, HTTP + workers in one process |
| **MikroORM** | Explicit Unit of Work + `EntityManager.transactional()` + `LockMode` (pessimistic / SKIP LOCKED) — preferred by the challenge |
| **PostgreSQL** | Source of truth for invariants (CHECK, UNIQUE, FK) |
| **LocalStack SQS FIFO** | Broker is an optimization; DB remains the consistency boundary |
| **decimal.js** | Exact decimal arithmetic; never `number`/`float` for money |

### Money persistence

`amount` + `currency` as separate columns (`NUMERIC(20,2)` + `CHAR(3)`). Rehydrated into the `Money` value object. ORM never owns monetary rules.

## Domain model

- **Money** — immutable; fixed scale 2; rejects scientific notation / empty / >2 decimals.
- **Wallet** — aggregate root; `version` increments only on balance change; debit/credit always produce a ledger entry.
- **WagerTransaction** — state machine with terminal statuses `PROCESSED | REJECTED | FAILED`.
- **WalletLedgerEntry** — structurally immutable; balanced arithmetic enforced in factory **and** DB CHECK.
- **Inbox / Outbox** — same SQL transaction as wallet + ledger mutations.

### Valid status transitions

```
PENDING ──────────────► PROCESSED
   │                        ▲
   ├─► PENDING_REFERENCE ───┘ (when reference appears)
   │         │
   │         └──────────────► REJECTED (timeout / rules)
   └────────────────────────► REJECTED | FAILED
```

Terminal states are immutable (programming error to transition).

## Failure codes

| Code | Meaning | Provider action |
|------|---------|-----------------|
| `INSUFFICIENT_BALANCE` | BET without funds | Do not retry same amount |
| `NEGATIVE_BALANCE_ON_REVERSAL` | ROLLBACK would go negative | Investigate; distinct from insufficient bet |
| `CURRENCY_MISMATCH` | Op currency ≠ wallet | Fix payload |
| `WALLET_NOT_FOUND` / `PLAYER_WALLET_MISMATCH` | Routing error | Fix ids |
| `IDEMPOTENCY_CONFLICT` | Same key, different payload | Stop; correct keying |
| `INVALID_PAYLOAD` / `INVALID_KIND` / `OPENING_NOT_ALLOWED` | Contract violation | Fix client |
| `MISSING_REFERENCE` / `REFERENCE_NOT_FOUND` / `REFERENCE_TIMEOUT` | Out-of-order exhausted | Investigate upstream |
| `REFERENCE_SCOPE_MISMATCH` / `INVALID_REFERENCE_KIND` / `AMOUNT_MISMATCH` | Reversal rules | Fix payload |
| `ALREADY_REVERSED` | Second REFUND/ROLLBACK of same kind | Idempotent business reject |
| `PERMANENT_INFRASTRUCTURE` | Non-retryable infra | Ops |

## Concurrency

**Unit of concurrency = `walletId`.**

Strategy: **pessimistic row lock** (`SELECT … FOR UPDATE`) on the wallet inside the financial transaction, acquired **before** inserting rows that FK-reference the wallet (avoids ShareLock→Exclusive upgrade deadlocks under multi-instance load). Transient `DeadlockException`s are retried with jitter (bounded).

Why not optimistic-only: hot wallets (section 8 scenario) would thrash on version conflicts; pessimistic serializes contenders on one row while other wallets remain fully parallel.

Global lock across all wallets is forbidden and unused.

### Section 8 guarantee

Initial 100.00, two concurrent BET 80.00 → exactly one `PROCESSED`, one `REJECTED` (`INSUFFICIENT_BALANCE`), balance 20.00, one DEBIT ledger row.

## Idempotency

1. Header `Idempotency-Key` is the source of truth (DB UNIQUE).
2. `payloadHash = SHA-256(canonicalJSON(businessFields))` — keys sorted recursively; transport metadata excluded.
3. Same key + same hash → replay original result (`idempotentReplay: true`).
4. Same key + different hash → conflict (409), not replay.
5. SQS path also persists **inbox** `(consumerName, messageId)` in the same transaction; ack only after commit.

## Ordering & references

REFUND/ROLLBACK with missing reference → `PENDING_REFERENCE` + outbox event. Worker reprocesses with exponential backoff (base 500ms, max attempts **8** ≈ ~1 min cumulative). Exhausted → `REJECTED` + `REFERENCE_TIMEOUT`.

## Transactional outbox

Wallet mutation + ledger + inbox + outbox row are **one** PostgreSQL transaction. Publishers claim due rows with `FOR UPDATE SKIP LOCKED` so multiple instances share work without losing or indefinitely duplicating. Consumers of events must still be idempotent (at-least-once publish).

## Auth (out of scope for scoring)

`AUTH_MODE=noop` with `NoopAuthGuard` and `ProviderIdentityPort`. Production would swap in OIDC (Keycloak/Zitadel) validating JWTs on HTTP; health stays open; SQS remains a trusted internal channel with domain validation of `providerId` in the payload.

## HTTP status mapping

| Situation | Status |
|-----------|--------|
| Invalid payload / missing Idempotency-Key | 400 |
| Idempotency conflict / wallet duplicate | 409 |
| Business rejection (`REJECTED`) | 422 |
| Accepted pending reference | 202 |
| Processed (incl. replay) | 200 |
| Transient infra | 503 / retry |

## Observability

- JSON logs with `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` — never full money payloads.
- Prometheus metrics: transactions by status, duplicates, retries, DLQ, lock conflicts, outbox lag, processing latency, reconciliation divergences.
- `/health/live` vs `/health/ready` (Postgres + SQS).

## PENDING_REFERENCE policy

- Base backoff **500ms**, exponential (`500 * 2^min(attempt,6)`).
- Max attempts **8** (~up to ~1 minute of retries depending on scheduling).
- Exhausted → `REJECTED` + `REFERENCE_TIMEOUT` + `WagerTransactionRejected` outbox event.

Justification: game-provider callbacks that arrive seconds apart should settle; longer gaps are operational incidents, not infinite waits.

## Trade-offs & limitations

- Single currency assumed in fixtures (BRL); model remains multi-currency.
- Partial refunds/rollbacks out of scope.
- Double-entry bookkeeping not implemented (optional).
- OpenTelemetry / dashboards optional and not shipped.
- Load characterization: `bun run test:load` (see `docs/LOAD_TEST.md`). Multi-instance correctness is covered by OS-level process tests in `test/concurrency/multi-instance.concurrency.test.ts`.
