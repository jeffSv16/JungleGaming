import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "../shared/domain-error";

export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Fixed monetary scale for the challenge (ISO-4217 minor units for BRL). */
const SCALE = 2;

const AMOUNT_PATTERN = /^-?\d+\.\d{2}$/;

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

/**
 * Immutable money value object.
 * Persisted/serialized as decimal strings with exactly 2 fractional digits.
 * Never uses JS number/float for arithmetic.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const currency = Money.assertCurrency(props.currency);
    const amount = Money.assertAmountString(props.amount);
    const value = new Decimal(amount);
    if (value.isNaN() || !value.isFinite()) {
      throw new InvalidMoneyError(`Invalid monetary amount: ${props.amount}`);
    }
    if (value.decimalPlaces() > SCALE) {
      throw new InvalidMoneyError(
        `Amount must have at most ${SCALE} decimal places: ${props.amount}`,
      );
    }
    return new Money(value.toDecimalPlaces(SCALE), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isLessThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThanOrEqualTo(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  /** Rejects negative amounts at input contract boundaries. */
  assertNonNegative(context = "amount"): void {
    if (this.isNegative()) {
      throw new InvalidMoneyError(`${context} must not be negative`);
    }
  }

  toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  toString(): string {
    return this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: string): string {
    if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyError(`Invalid ISO-4217 currency: ${currency}`);
    }
    return currency;
  }

  private static assertAmountString(amount: string): string {
    if (typeof amount !== "string" || amount.trim() === "") {
      throw new InvalidMoneyError("Amount must be a non-empty decimal string");
    }
    if (amount !== amount.trim()) {
      throw new InvalidMoneyError("Amount must not have leading/trailing whitespace");
    }
    if (/[eE]/.test(amount)) {
      throw new InvalidMoneyError("Scientific notation is not allowed for money amounts");
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `Amount must match ^-?\\d+\\.\\d{2}$ (got: ${amount})`,
      );
    }
    return amount;
  }
}
