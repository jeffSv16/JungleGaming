import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { Wallet } from "../../src/domain/wallet/wallet";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction/wager-transaction";
import { LedgerDirection } from "../../src/domain/ledger/wallet-ledger-entry";
import { FailureCode } from "../../src/domain/shared/failure-code";
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvalidTransactionStateError,
} from "../../src/domain/shared/domain-error";
import {
  computePayloadHash,
  wagerBusinessPayload,
} from "../../src/domain/shared/payload-hash";

function makeTx(
  kind: WagerTransactionKind,
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) {
  return WagerTransaction.create({
    id: overrides.id ?? crypto.randomUUID(),
    providerId: "provider-a",
    externalTransactionId: overrides.externalTransactionId ?? crypto.randomUUID(),
    idempotencyKey:
      overrides.idempotencyKey ??
      `provider-a:${overrides.externalTransactionId ?? crypto.randomUUID()}`,
    payloadHash: overrides.payloadHash ?? "hash",
    walletId: "w1",
    playerId: "p1",
    roundId: "r1",
    gameId: "g1",
    kind,
    money:
      overrides.money ?? Money.from({ amount: "25.00", currency: "BRL" }),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
  });
}

describe("business rules: BET WIN LOSS REFUND ROLLBACK", () => {
  test("BET debits wallet and writes DEBIT ledger; rejects insufficient", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    const bet = makeTx(WagerTransactionKind.Bet);
    expect(bet.affectsBalance()).toBe(true);
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);

    const { entry } = wallet.debit({
      entryId: "e1",
      transactionId: bet.id,
      money: bet.money,
      at: new Date(),
    });
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe("75.00");

    expect(() =>
      wallet.debit({
        entryId: "e2",
        transactionId: "t2",
        money: Money.from({ amount: "80.00", currency: "BRL" }),
        at: new Date(),
      }),
    ).toThrow(InsufficientBalanceError);
  });

  test("WIN credits; may optionally reference BET", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({ amount: "75.00", currency: "BRL" }),
    });
    const win = makeTx(WagerTransactionKind.Win, {
      referenceExternalTransactionId: "bet-ext-1",
      money: Money.from({ amount: "40.00", currency: "BRL" }),
    });
    expect(win.requiresReference()).toBe(false);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    wallet.credit({
      entryId: "e1",
      transactionId: win.id,
      money: win.money,
      at: new Date(),
    });
    expect(wallet.balance.toString()).toBe("115.00");
  });

  test("LOSS does not affect balance and has no ledger direction", () => {
    const loss = makeTx(WagerTransactionKind.Loss);
    expect(loss.affectsBalance()).toBe(false);
    expect(loss.ledgerDirectionFor()).toBeNull();
  });

  test("REFUND requires reference to BET and credits equal amount", () => {
    expect(() => makeTx(WagerTransactionKind.Refund)).toThrow(
      InvalidTransactionStateError,
    );
    const refund = makeTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: "bet-1",
    });
    expect(refund.requiresReference()).toBe(true);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("ROLLBACK inverts BET (credit) and WIN (debit)", () => {
    const bet = makeTx(WagerTransactionKind.Bet);
    const win = makeTx(WagerTransactionKind.Win, {
      externalTransactionId: "win-1",
      idempotencyKey: "provider-a:win-1",
    });
    const rbBet = makeTx(WagerTransactionKind.Rollback, {
      externalTransactionId: "rb-bet",
      idempotencyKey: "provider-a:rb-bet",
      referenceExternalTransactionId: "x",
    });
    const rbWin = makeTx(WagerTransactionKind.Rollback, {
      externalTransactionId: "rb-win",
      idempotencyKey: "provider-a:rb-win",
      referenceExternalTransactionId: "y",
    });
    expect(rbBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rbWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  test("currency mismatch on wallet operations", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
    });
    expect(() =>
      wallet.debit({
        entryId: "e",
        transactionId: "t",
        money: Money.from({ amount: "1.00", currency: "USD" }),
        at: new Date(),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  test("idempotency key with divergent payload is not a match", () => {
    const base = {
      providerId: "provider-a",
      externalTransactionId: "tx-1",
      playerId: "p1",
      walletId: "w1",
      roundId: "r1",
      gameId: "g1",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    };
    const h1 = computePayloadHash(wagerBusinessPayload(base));
    const h2 = computePayloadHash(
      wagerBusinessPayload({
        ...base,
        money: { amount: "26.00", currency: "BRL" },
      }),
    );
    const tx = makeTx(WagerTransactionKind.Bet, { payloadHash: h1 });
    expect(tx.matchesPayload(h1)).toBe(true);
    expect(tx.matchesPayload(h2)).toBe(false);
  });

  test("terminal reject cannot be reprocessed", () => {
    const tx = makeTx(WagerTransactionKind.Bet);
    tx.reject(FailureCode.InsufficientBalance, Money.zero("BRL"));
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(() =>
      tx.markProcessed(undefined, new Date(), Money.zero("BRL")),
    ).toThrow(InvalidTransactionStateError);
  });
});
