/**
 * bun run test:load
 *
 * Environment / methodology documented in docs/LOAD_TEST.md (and printed here).
 * Not a pass/fail gate — honesty over vanity RPS.
 */
import "reflect-metadata";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { CreateWalletUseCase } from "../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerUseCase } from "../src/application/use-cases/process-wager.use-case";
import { ReconcileWalletUseCase } from "../src/application/use-cases/reconcile-wallet.use-case";
import { MikroORM } from "@mikro-orm/core";
import { OutboxMessageEntity } from "../src/infrastructure/persistence/entities/outbox-message.entity";
import { MetricsService } from "../src/infrastructure/observability/metrics.service";

process.env.DISABLE_WORKERS = "true";

const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 20);
const TOTAL = Number(process.env.LOAD_TOTAL ?? 400);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const orm = app.get(MikroORM);
  await orm.getMigrator().up();
  await orm.em.getConnection().execute(`
    TRUNCATE TABLE transaction_reversals, outbox_messages, inbox_messages,
      wallet_ledger_entries, wager_transactions, wallets RESTART IDENTITY CASCADE
  `);

  const createWallet = app.get(CreateWalletUseCase);
  const processWager = app.get(ProcessWagerUseCase);
  const reconcile = app.get(ReconcileWalletUseCase);
  const metrics = app.get(MetricsService);

  const wallet = await createWallet.execute({
    playerId: randomUUID(),
    initialBalance: { amount: "100000.00", currency: "BRL" },
  });

  const latencies: number[] = [];
  let errors = 0;
  let done = 0;
  const started = performance.now();

  async function worker(id: number): Promise<void> {
    while (true) {
      const n = done++;
      if (n >= TOTAL) return;
      const t0 = performance.now();
      try {
        await processWager.execute({
          providerId: "provider-a",
          externalTransactionId: `load-${id}-${n}`,
          idempotencyKey: `provider-a:load-${id}-${n}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: `r-${n}`,
          gameId: "load",
          kind: "BET",
          money: { amount: "1.00", currency: "BRL" },
        });
        latencies.push(performance.now() - t0);
      } catch {
        errors += 1;
        latencies.push(performance.now() - t0);
      }
    }
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => worker(i)),
  );
  const elapsedSec = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);

  const rec = await reconcile.execute(wallet.id);
  const pendingOutbox = await orm.em.fork().count(OutboxMessageEntity, {
    publishedAt: null,
  });

  const report = {
    environment: {
      runtime: `bun ${Bun.version}`,
      concurrency: CONCURRENCY,
      totalOps: TOTAL,
      postgres: process.env.POSTGRES_HOST ?? "127.0.0.1",
      note: "Single Nest application context; wallet row lock serializes hot-wallet BETs",
    },
    methodology:
      "N concurrent async workers issue unique BET 1.00 against one hot wallet with pessimistic locking. Measures end-to-end use-case latency, not HTTP.",
    throughputRps: Number((TOTAL / elapsedSec).toFixed(2)),
    elapsedSec: Number(elapsedSec.toFixed(3)),
    latencyMs: {
      p50: Number(percentile(latencies, 50).toFixed(2)),
      p95: Number(percentile(latencies, 95).toFixed(2)),
      p99: Number(percentile(latencies, 99).toFixed(2)),
    },
    errorRate: Number((errors / TOTAL).toFixed(4)),
    reconciliation: rec,
    outboxLagPending: pendingOutbox,
    lockConflictsHint:
      "See wager_lock_conflicts_total / wager_processing_latency_seconds in /metrics when server is up",
  };

  console.log(JSON.stringify(report, null, 2));
  // Touch metrics so the module is exercised
  void metrics;
  await app.close();

  if (!rec.consistent) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
