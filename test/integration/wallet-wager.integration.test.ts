import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/core";
import { createTestApp, resetDatabase } from "../helpers/app";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerUseCase } from "../../src/application/use-cases/process-wager.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { WagerTransactionStatus } from "../../src/domain/wager-transaction/wager-transaction";
import { FailureCode } from "../../src/domain/shared/failure-code";
import { WalletLedgerEntryEntity } from "../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { OutboxMessageEntity } from "../../src/infrastructure/persistence/entities/outbox-message.entity";
import { InboxMessageEntity } from "../../src/infrastructure/persistence/entities/inbox-message.entity";

describe("integration: wallet + wager", () => {
  let app: INestApplication;
  let orm: MikroORM;
  let createWallet: CreateWalletUseCase;
  let processWager: ProcessWagerUseCase;
  let reconcile: ReconcileWalletUseCase;

  beforeAll(async () => {
    ({ app, orm } = await createTestApp());
    createWallet = app.get(CreateWalletUseCase);
    processWager = app.get(ProcessWagerUseCase);
    reconcile = app.get(ReconcileWalletUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  test("create wallet with OPENING ledger + outbox atomicity", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "1000.00", currency: "BRL" },
    });
    expect(wallet.balance.amount).toBe("1000.00");
    expect(wallet.version).toBe(1);

    const ledger = await orm.em.fork().find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.direction).toBe("CREDIT");

    const outbox = await orm.em.fork().find(OutboxMessageEntity, {});
    expect(outbox.length).toBeGreaterThanOrEqual(2);

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
  });

  test("BET debits once; identical retry is idempotent replay", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const payload = {
      providerId: "provider-a",
      externalTransactionId: "tx-1",
      idempotencyKey: "provider-a:tx-1",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    };
    const first = await processWager.execute(payload);
    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(first.balance?.amount).toBe("75.00");
    expect(first.idempotentReplay).toBe(false);

    const second = await processWager.execute(payload);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balance?.amount).toBe("75.00");

    const ledger = await orm.em.fork().find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
    });
    // OPENING + one BET debit
    expect(ledger).toHaveLength(2);
    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
  });

  test("idempotency key with divergent payload conflicts", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-1",
      idempotencyKey: "provider-a:tx-1",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    });

    let conflict = false;
    try {
      await processWager.execute({
        providerId: "provider-a",
        externalTransactionId: "tx-1",
        idempotencyKey: "provider-a:tx-1",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "30.00", currency: "BRL" },
      });
    } catch {
      conflict = true;
    }
    expect(conflict).toBe(true);
  });

  test("inbox dedup + redelivery does not double debit", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const base = {
      providerId: "provider-a",
      externalTransactionId: "tx-inbox",
      idempotencyKey: "provider-a:tx-inbox",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
      inbox: { messageId: "msg-1", consumerName: "wager-transactions-consumer" },
    };
    await processWager.execute(base);
    await processWager.execute(base);

    const inbox = await orm.em.fork().find(InboxMessageEntity, {
      messageId: "msg-1",
    });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.processedAt).toBeTruthy();

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("90.00");
  });

  test("REFUND before BET stays PENDING_REFERENCE then processes", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const refund = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-refund",
      idempotencyKey: "provider-a:tx-refund",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "REFUND",
      money: { amount: "20.00", currency: "BRL" },
      referenceExternalTransactionId: "tx-bet",
    });
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    const bet = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-bet",
      idempotencyKey: "provider-a:tx-bet",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "20.00", currency: "BRL" },
    });
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    const after = await processWager.reprocess(refund.transactionId);
    expect(after.status).toBe(WagerTransactionStatus.Processed);
    expect(after.balance?.amount).toBe("100.00");

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
  });

  test("LOSS does not create ledger entry", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-bet",
      idempotencyKey: "provider-a:tx-bet",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    });
    const loss = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-loss",
      idempotencyKey: "provider-a:tx-loss",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "g",
      kind: "LOSS",
      money: { amount: "10.00", currency: "BRL" },
    });
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.balance?.amount).toBe("90.00");
    const ledger = await orm.em.fork().count(WalletLedgerEntryEntity, {
      walletId: wallet.id,
    });
    expect(ledger).toBe(2); // OPENING + BET
  });

  test("insufficient balance rejects with distinct failure code", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const result = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-big",
      idempotencyKey: "provider-a:tx-big",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "50.00", currency: "BRL" },
    });
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientBalance);
  });
});
