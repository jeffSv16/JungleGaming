import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/core";
import { createTestApp, resetDatabase } from "../helpers/app";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerUseCase } from "../../src/application/use-cases/process-wager.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { WagerTransactionStatus } from "../../src/domain/wager-transaction/wager-transaction";
import { WalletLedgerEntryEntity } from "../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { OutboxPublisher } from "../../src/interfaces/workers/outbox.publisher";
import { OutboxMessageEntity } from "../../src/infrastructure/persistence/entities/outbox-message.entity";

describe("concurrency: hot wallet", () => {
  let app: INestApplication;
  let orm: MikroORM;
  let createWallet: CreateWalletUseCase;
  let processWager: ProcessWagerUseCase;
  let reconcile: ReconcileWalletUseCase;
  let outbox: OutboxPublisher;

  beforeAll(async () => {
    ({ app, orm } = await createTestApp());
    createWallet = app.get(CreateWalletUseCase);
    processWager = app.get(ProcessWagerUseCase);
    reconcile = app.get(ReconcileWalletUseCase);
    outbox = app.get(OutboxPublisher);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  test("section 8: two concurrent 80 bets on 100 → one processed, one rejected, balance 20", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const mk = (n: number) =>
      processWager.execute({
        providerId: "provider-a",
        externalTransactionId: `tx-race-${n}`,
        idempotencyKey: `provider-a:tx-race-${n}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `round-${n}`,
        gameId: "g",
        kind: "BET",
        money: { amount: "80.00", currency: "BRL" },
      });

    const [a, b] = await Promise.all([mk(1), mk(2)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("20.00");

    const debits = await orm.em.fork().find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: "DEBIT",
    });
    expect(debits).toHaveLength(1);
  });

  test("same bet sent 50 times in parallel → single debit", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const payload = {
      providerId: "provider-a",
      externalTransactionId: "tx-dup-50",
      idempotencyKey: "provider-a:tx-dup-50",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "15.00", currency: "BRL" },
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => processWager.execute(payload)),
    );
    const processed = results.filter(
      (r) => r.status === WagerTransactionStatus.Processed,
    );
    expect(processed.length).toBe(50);
    const ids = new Set(results.map((r) => r.transactionId));
    expect(ids.size).toBe(1);

    const debits = await orm.em.fork().find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: "DEBIT",
    });
    expect(debits).toHaveLength(1);

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("85.00");
  });

  test("distinct wallets process in parallel", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 5 }, () =>
        createWallet.execute({
          playerId: randomUUID(),
          initialBalance: { amount: "50.00", currency: "BRL" },
        }),
      ),
    );

    await Promise.all(
      wallets.map((w, i) =>
        processWager.execute({
          providerId: "provider-a",
          externalTransactionId: `tx-par-${i}`,
          idempotencyKey: `provider-a:tx-par-${i}`,
          playerId: w.playerId,
          walletId: w.id,
          roundId: "r",
          gameId: "g",
          kind: "BET",
          money: { amount: "10.00", currency: "BRL" },
        }),
      ),
    );

    for (const w of wallets) {
      const rec = await reconcile.execute(w.id);
      expect(rec.consistent).toBe(true);
      expect(rec.storedBalance.amount).toBe("40.00");
    }
  });

  test("two concurrent outbox publishers claim without indefinite duplication", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-outbox",
      idempotencyKey: "provider-a:tx-outbox",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "1.00", currency: "BRL" },
    });

    const url =
      process.env.SQS_EVENTS_QUEUE_URL ??
      "http://127.0.0.1:4566/000000000000/wager-events.fifo";

    await Promise.all([
      outbox.publishBatch(url, 50),
      outbox.publishBatch(url, 50),
      outbox.publishBatch(url, 50),
    ]);

    const pending = await orm.em.fork().count(OutboxMessageEntity, {
      publishedAt: null,
    });
    expect(pending).toBe(0);
  });
});
