# Load test notes

Run:

```bash
bun run test:load
# optional: LOAD_CONCURRENCY=40 LOAD_TOTAL=1000 bun run test:load
```

## Environment

- Bun 1.x
- PostgreSQL 16 (local or Compose)
- Single Nest application context (not a multi-node cluster)
- Hot wallet under pessimistic `SELECT FOR UPDATE`

## Methodology

Concurrent async workers submit unique `BET 1.00` operations against one wallet. Throughput is limited by row-level locking on that wallet — this is intentional and mirrors production hot-wallet behavior. We report p50/p95/p99 of use-case latency, error rate, reconciliation consistency, and pending outbox count.

There is **no RPS target**. The value is honest characterization of contention under the chosen concurrency strategy.
