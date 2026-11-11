import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { Wallet } from "../../src/domain/wallet/wallet";
import { LedgerDirection } from "../../src/domain/ledger/wallet-ledger-entry";
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  NegativeBalanceError,
} from "../../src/domain/shared/domain-error";

describe("Wallet", () => {
  test("open starts at version 1", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("debit decreases balance, increments version, writes DEBIT ledger", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    const { entry } = wallet.debit({
      entryId: "e1",
      transactionId: "t1",
      money: Money.from({ amount: "80.00", currency: "BRL" }),
      at: new Date(),
    });
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
  });

  test("insufficient balance rejects without mutating", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
    });
    expect(() =>
      wallet.debit({
        entryId: "e1",
        transactionId: "t1",
        money: Money.from({ amount: "80.00", currency: "BRL" }),
        at: new Date(),
      }),
    ).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toString()).toBe("50.00");
    expect(wallet.version).toBe(1);
  });

  test("currency mismatch", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
    });
    expect(() =>
      wallet.credit({
        entryId: "e1",
        transactionId: "t1",
        money: Money.from({ amount: "10.00", currency: "USD" }),
        at: new Date(),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  test("rollback inverse that would go negative throws NegativeBalanceError", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
    });
    expect(() =>
      wallet.applyInverse({
        entryId: "e1",
        transactionId: "t1",
        originalDirection: LedgerDirection.Credit,
        money: Money.from({ amount: "20.00", currency: "BRL" }),
        at: new Date(),
      }),
    ).toThrow(NegativeBalanceError);
  });

  test("rehydrate does not revalidate transitions", () => {
    const wallet = Wallet.rehydrate({
      id: "w1",
      playerId: "p1",
      currency: "BRL",
      balance: { amount: "5.00", currency: "BRL" },
      version: 9,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(wallet.version).toBe(9);
    expect(wallet.balance.toString()).toBe("5.00");
  });
});
