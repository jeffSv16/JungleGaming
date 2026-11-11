# Load test results (sample)

Captured in the challenge environment.

```json
{
  "environment": {
    "runtime": "bun 1.4.4",
    "concurrency": 20,
    "totalOps": 200,
    "postgres": "127.0.0.1",
    "note": "Single Nest application context; wallet row lock serializes hot-wallet BETs"
  },
  "methodology": "N concurrent async workers issue unique BET 1.00 against one hot wallet with pessimistic locking. Measures end-to-end use-case latency, not HTTP.",
  "throughputRps": 192.09,
  "elapsedSec": 1.041,
  "latencyMs": { "p50": 94.64, "p95": 149.42, "p99": 181.03 },
  "errorRate": 0,
  "reconciliation": { "consistent": true, "difference": { "amount": "0.00", "currency": "BRL" } },
  "outboxLagPending": 102
}
```

Interpretation: throughput is bounded by pessimistic locking on a single hot wallet — expected. Consistency held (`wallet.balance == ledger`). Pending outbox count reflects `DISABLE_WORKERS=true` during the load run (publisher not draining).
