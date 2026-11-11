import {
  describe,
  expect,
  test,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
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

describe("integration: WIN / REFUND / ROLLBACK", () => {
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

  test("full round: BET → WIN credits; ledger consistent", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "p",
      externalTransactionId: "bet1",
      idempotencyKey: "p:bet1",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r1",
      gameId: "g",
      kind: "BET",
      money: { amount: "40.00", currency: "BRL" },
    });
    const win = await processWager.execute({
      providerId: "p",
      externalTransactionId: "win1",
      idempotencyKey: "p:win1",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r1",
      gameId: "g",
      kind: "WIN",
      money: { amount: "90.00", currency: "BRL" },
      referenceExternalTransactionId: "bet1",
    });
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.balance?.amount).toBe("150.00");
    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
  });

  test("ROLLBACK BET restores balance; second ROLLBACK rejected", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "p",
      externalTransactionId: "bet2",
      idempotencyKey: "p:bet2",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r1",
      gameId: "g",
      kind: "BET",
      money: { amount: "40.00", currency: "BRL" },
    });
    const rb = await processWager.execute({
      providerId: "p",
      externalTransactionId: "rb1",
      idempotencyKey: "p:rb1",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r1",
      gameId: "g",
      kind: "ROLLBACK",
      money: { amount: "40.00", currency: "BRL" },
      referenceExternalTransactionId: "bet2",
    });
    expect(rb.status).toBe(WagerTransactionStatus.Processed);
    expect(rb.balance?.amount).toBe("100.00");

    const rb2 = await processWager.execute({
      providerId: "p",
      externalTransactionId: "rb2",
      idempotencyKey: "p:rb2",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r1",
      gameId: "g",
      kind: "ROLLBACK",
      money: { amount: "40.00", currency: "BRL" },
      referenceExternalTransactionId: "bet2",
    });
    expect(rb2.status).toBe(WagerTransactionStatus.Rejected);
    expect(rb2.failureCode).toBe(FailureCode.AlreadyReversed);
  });

  test("ROLLBACK that would go negative uses NEGATIVE_BALANCE_ON_REVERSAL", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    // Credit via WIN without prior bet (allowed) then try to rollback that WIN after draining
    await processWager.execute({
      providerId: "p",
      externalTransactionId: "win-neg",
      idempotencyKey: "p:win-neg",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r1",
      gameId: "g",
      kind: "WIN",
      money: { amount: "5.00", currency: "BRL" },
    });
    // Drain balance below rollback debit requirement
    await processWager.execute({
      providerId: "p",
      externalTransactionId: "bet-drain",
      idempotencyKey: "p:bet-drain",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r2",
      gameId: "g",
      kind: "BET",
      money: { amount: "15.00", currency: "BRL" },
    });
    // Balance is 0. Rolling back WIN (inverse of CREDIT = DEBIT 5) would go negative? 
    // balance is 0, debit 5 → negative → NEGATIVE_BALANCE_ON_REVERSAL
    const rb = await processWager.execute({
      providerId: "p",
      externalTransactionId: "rb-neg",
      idempotencyKey: "p:rb-neg",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r1",
      gameId: "g",
      kind: "ROLLBACK",
      money: { amount: "5.00", currency: "BRL" },
      referenceExternalTransactionId: "win-neg",
    });
    expect(rb.status).toBe(WagerTransactionStatus.Rejected);
    expect(rb.failureCode).toBe(FailureCode.NegativeBalanceOnReversal);
    expect(rb.failureCode).not.toBe(FailureCode.InsufficientBalance);

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
  });

  test("currency mismatch rejects with CURRENCY_MISMATCH", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const result = await processWager.execute({
      providerId: "p",
      externalTransactionId: "fx",
      idempotencyKey: "p:fx",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "USD" },
    });
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    const debits = await orm.em.fork().count(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: "DEBIT",
    });
    expect(debits).toBe(0);
  });
});
