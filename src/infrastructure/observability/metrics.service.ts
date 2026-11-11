import { Injectable, OnModuleInit } from "@nestjs/common";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  readonly transactions: Counter;
  readonly duplicates: Counter;
  readonly retries: Counter;
  readonly dlq: Counter;
  readonly lockConflicts: Counter;
  readonly outboxLag: Gauge;
  readonly processingLatency: Histogram;
  readonly reconciliationDivergences: Counter;

  constructor() {
    this.transactions = new Counter({
      name: "wager_transactions_total",
      help: "Wager transactions by status and kind",
      labelNames: ["status", "kind"] as const,
      registers: [this.registry],
    });
    this.duplicates = new Counter({
      name: "wager_duplicates_total",
      help: "Detected duplicate deliveries / idempotent replays",
      labelNames: ["source"] as const,
      registers: [this.registry],
    });
    this.retries = new Counter({
      name: "wager_retries_total",
      help: "Transient retries",
      labelNames: ["component"] as const,
      registers: [this.registry],
    });
    this.dlq = new Counter({
      name: "wager_dlq_messages_total",
      help: "Messages sent to DLQ",
      registers: [this.registry],
    });
    this.lockConflicts = new Counter({
      name: "wager_lock_conflicts_total",
      help: "Concurrency / business conflicts under wallet lock",
      labelNames: ["reason"] as const,
      registers: [this.registry],
    });
    this.outboxLag = new Gauge({
      name: "wager_outbox_lag_seconds",
      help: "Age of oldest unpublished outbox message",
      registers: [this.registry],
    });
    this.processingLatency = new Histogram({
      name: "wager_processing_latency_seconds",
      help: "End-to-end processing latency",
      labelNames: ["kind"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [this.registry],
    });
    this.reconciliationDivergences = new Counter({
      name: "wager_reconciliation_divergences_total",
      help: "Wallet vs ledger divergences detected",
      registers: [this.registry],
    });
  }

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry });
  }

  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }
}
