import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from "../../src/domain/shared/domain-error";

describe("Money", () => {
  test("from parses fixed-scale decimal string", () => {
    const money = Money.from({ amount: "25.00", currency: "BRL" });
    expect(money.toString()).toBe("25.00");
    expect(money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  test("zero creates 0.00 in the given currency", () => {
    expect(Money.zero("BRL").toJSON()).toEqual({
      amount: "0.00",
      currency: "BRL",
    });
  });

  test("add/subtract return new immutable instances", () => {
    const a = Money.from({ amount: "10.00", currency: "BRL" });
    const b = Money.from({ amount: "2.50", currency: "BRL" });
    const sum = a.add(b);
    const diff = a.subtract(b);
    expect(sum.toString()).toBe("12.50");
    expect(diff.toString()).toBe("7.50");
    expect(a.toString()).toBe("10.00");
  });

  test("negate flips sign", () => {
    expect(
      Money.from({ amount: "5.00", currency: "BRL" }).negate().toString(),
    ).toBe("-5.00");
  });

  test("comparison helpers", () => {
    const a = Money.from({ amount: "1.00", currency: "BRL" });
    const b = Money.from({ amount: "2.00", currency: "BRL" });
    expect(a.isLessThan(b)).toBe(true);
    expect(a.isPositive()).toBe(true);
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(a.equals(Money.from({ amount: "1.00", currency: "BRL" }))).toBe(
      true,
    );
  });

  test("rejects empty / scientific / wrong scale / invalid currency", () => {
    expect(() => Money.from({ amount: "", currency: "BRL" })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: "1e2", currency: "BRL" })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: "1.001", currency: "BRL" })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: "1.0", currency: "BRL" })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: "10", currency: "BRL" })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: "10.00", currency: "brl" })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: "NaN", currency: "BRL" })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: "Infinity", currency: "BRL" })).toThrow(
      InvalidMoneyError,
    );
  });

  test("currency mismatch on arithmetic", () => {
    const brl = Money.from({ amount: "1.00", currency: "BRL" });
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test("assertNonNegative rejects negatives at contract boundary", () => {
    const negative = Money.from({ amount: "-1.00", currency: "BRL" });
    expect(() => negative.assertNonNegative("money")).toThrow(
      InvalidMoneyError,
    );
  });
});
