import { Money, type MoneyProps } from "../money/money";
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  NegativeBalanceError,
} from "../shared/domain-error";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../ledger/wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMutationResult {
  wallet: Wallet;
  entry: WalletLedgerEntry;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    createdAt?: Date;
  }): Wallet {
    props.initialBalance.assertNonNegative("initialBalance");
    const now = props.createdAt ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }


  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: {
    entryId: string;
    transactionId: string;
    money: Money;
    at: Date;
    allowNegative?: false;
  }): WalletMutationResult {
    this.assertSameCurrency(props.money);
    props.money.assertNonNegative("debit amount");
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientBalanceError();
    }
    const before = this._balance;
    const after = before.subtract(props.money);
    if (after.isNegative()) {
      throw new NegativeBalanceError();
    }
    this._balance = after;
    this._version += 1;
    this._updatedAt = props.at;
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Debit,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: props.at,
    });
    return { wallet: this, entry };
  }

  credit(props: {
    entryId: string;
    transactionId: string;
    money: Money;
    at: Date;
  }): WalletMutationResult {
    this.assertSameCurrency(props.money);
    props.money.assertNonNegative("credit amount");
    const before = this._balance;
    const after = before.add(props.money);
    this._balance = after;
    this._version += 1;
    this._updatedAt = props.at;
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: props.at,
    });
    return { wallet: this, entry };
  }


  applyInverse(props: {
    entryId: string;
    transactionId: string;
    originalDirection: LedgerDirection;
    money: Money;
    at: Date;
  }): WalletMutationResult {
    this.assertSameCurrency(props.money);
    props.money.assertNonNegative("rollback amount");
    const inverseDirection =
      props.originalDirection === LedgerDirection.Debit
        ? LedgerDirection.Credit
        : LedgerDirection.Debit;

    if (inverseDirection === LedgerDirection.Debit) {
      if (this._balance.isLessThan(props.money)) {
        throw new NegativeBalanceError(
          "Rollback would result in negative balance",
        );
      }
      return this.debit({
        entryId: props.entryId,
        transactionId: props.transactionId,
        money: props.money,
        at: props.at,
      });
    }
    return this.credit({
      entryId: props.entryId,
      transactionId: props.transactionId,
      money: props.money,
      at: props.at,
    });
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance.toJSON(),
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
