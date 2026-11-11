import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction/wager-transaction";
import { FailureCode } from "../../src/domain/shared/failure-code";
import { InvalidTransactionStateError } from "../../src/domain/shared/domain-error";
import { LedgerDirection } from "../../src/domain/ledger/wallet-ledger-entry";
import {
  computePayloadHash,
  wagerBusinessPayload,
} from "../../src/domain/shared/payload-hash";

function bet(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  return WagerTransaction.create({
    id: "t1",
    providerId: "provider-a",
    externalTransactionId: "tx-1",
    idempotencyKey: "provider-a:tx-1",
    payloadHash: "hash",
    walletId: "w1",
    playerId: "p1",
    roundId: "r1",
    gameId: "g1",
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: "25.00", currency: "BRL" }),
    ...overrides,
  });
}

describe("WagerTransaction", () => {
  test("BET debits; LOSS does not affect balance", () => {
    const b = bet();
    expect(b.affectsBalance()).toBe(true);
    expect(b.ledgerDirectionFor()).toBe(LedgerDirection.Debit);

    const loss = bet({
      id: "t2",
      kind: WagerTransactionKind.Loss,
      externalTransactionId: "tx-2",
      idempotencyKey: "provider-a:tx-2",
    });
    expect(loss.affectsBalance()).toBe(false);
    expect(loss.ledgerDirectionFor()).toBeNull();
  });

  test("REFUND/ROLLBACK require reference", () => {
    expect(() =>
      bet({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: undefined,
      }),
    ).toThrow(InvalidTransactionStateError);
  });

  test("OPENING cannot be created via create()", () => {
    expect(() =>
      bet({ kind: WagerTransactionKind.Opening }),
    ).toThrow(InvalidTransactionStateError);
  });

  test("terminal states cannot transition", () => {
    const tx = bet();
    tx.markProcessed(undefined, new Date(), Money.from({ amount: "75.00", currency: "BRL" }));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(() => tx.reject(FailureCode.InsufficientBalance)).toThrow(
      InvalidTransactionStateError,
    );
  });

  test("idempotency payload hash diverges on field change", () => {
    const a = computePayloadHash(
      wagerBusinessPayload({
        providerId: "provider-a",
        externalTransactionId: "tx-1",
        playerId: "p1",
        walletId: "w1",
        roundId: "r1",
        gameId: "g1",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      }),
    );
    const b = computePayloadHash(
      wagerBusinessPayload({
        providerId: "provider-a",
        externalTransactionId: "tx-1",
        playerId: "p1",
        walletId: "w1",
        roundId: "r1",
        gameId: "g1",
        kind: "BET",
        money: { amount: "30.00", currency: "BRL" },
      }),
    );
    expect(a).not.toBe(b);
    const tx = bet({ payloadHash: a });
    expect(tx.matchesPayload(a)).toBe(true);
    expect(tx.matchesPayload(b)).toBe(false);
  });

  test("ROLLBACK inverts reference ledger direction", () => {
    const original = bet();
    const rollback = bet({
      id: "t-rb",
      kind: WagerTransactionKind.Rollback,
      externalTransactionId: "tx-rb",
      idempotencyKey: "provider-a:tx-rb",
      referenceExternalTransactionId: "tx-1",
    });
    expect(rollback.ledgerDirectionFor(original)).toBe(LedgerDirection.Credit);
  });
});
