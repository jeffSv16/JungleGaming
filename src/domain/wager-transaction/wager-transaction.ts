import { Money, type MoneyProps } from "../money/money";
import { FailureCode } from "../shared/failure-code";
import { InvalidTransactionStateError } from "../shared/domain-error";
import { LedgerDirection } from "../ledger/wallet-ledger-entry";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: MoneyProps;
  attemptCount: number;
  nextAttemptAt?: Date;
}

const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Valid transitions:
 * PENDING -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 * PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (retry)
 * PROCESSED | REJECTED | FAILED -> (none — terminal)
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _attemptCount: number = 0,
    private _nextAttemptAt?: Date,
  ) {}

  /** Born PENDING. Validates reference requirements by kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionStateError(
        "OPENING cannot be submitted via API or queue",
      );
    }
    props.money.assertNonNegative("transaction money");
    const requiresRef =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;
    if (requiresRef && !props.referenceExternalTransactionId) {
      throw new InvalidTransactionStateError(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (!requiresRef && props.referenceExternalTransactionId) {
      // WIN may optionally reference a BET; allow optional refs for WIN.
      if (props.kind !== WagerTransactionKind.Win) {
        throw new InvalidTransactionStateError(
          `${props.kind} must not carry referenceExternalTransactionId`,
        );
      }
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    createdAt?: Date;
  }): WagerTransaction {
    props.money.assertNonNegative("opening money");
    const now = props.createdAt ?? new Date();
    return new WagerTransaction(
      props.id,
      "system",
      `opening:${props.walletId}`,
      `opening:${props.walletId}`,
      "opening",
      props.walletId,
      props.playerId,
      `opening:${props.walletId}`,
      "system",
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      now,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      now,
      props.money,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from(state.money),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance ? Money.from(state.observedBalance) : undefined,
      state.attemptCount,
      state.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get attemptCount(): number {
    return this._attemptCount;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance: Money,
  ): void {
    this.assertNotTerminal("markProcessed");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._failureCode = undefined;
    this._nextAttemptAt = undefined;
  }

  markPendingReference(now: Date, backoffMs: number): void {
    this.assertNotTerminal("markPendingReference");
    this._status = WagerTransactionStatus.PendingReference;
    this._attemptCount += 1;
    this._nextAttemptAt = new Date(now.getTime() + backoffMs);
  }

  reject(code: FailureCode, observedBalance?: Money): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = new Date();
    this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = new Date();
    this._nextAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Ledger direction for this transaction relative to an optional reference.
   * LOSS has no ledger. ROLLBACK inverts the reference direction.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | null {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return null;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError(
            "ROLLBACK requires a resolved reference to determine ledger direction",
          );
        }
        const original = reference.ledgerDirectionFor();
        if (original === null) {
          throw new InvalidTransactionStateError(
            "Cannot rollback a transaction that did not affect balance",
          );
        }
        return original === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      default:
        return null;
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money.toJSON(),
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
      observedBalance: this._observedBalance?.toJSON(),
      attemptCount: this._attemptCount,
      nextAttemptAt: this._nextAttemptAt,
    };
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot ${action} transaction in terminal status ${this._status}`,
      );
    }
  }
}
