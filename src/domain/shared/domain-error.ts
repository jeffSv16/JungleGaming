export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message, "INVALID_MONEY");
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(left: string, right: string) {
    super(`Currency mismatch: ${left} vs ${right}`, "CURRENCY_MISMATCH");
  }
}

export class InsufficientBalanceError extends DomainError {
  constructor(message = "Insufficient wallet balance") {
    super(message, "INSUFFICIENT_BALANCE");
  }
}

export class NegativeBalanceError extends DomainError {
  constructor(message = "Operation would result in negative balance") {
    super(message, "NEGATIVE_BALANCE");
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super(message, "INVALID_TRANSACTION_STATE");
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(message = "Idempotency key reused with a different payload") {
    super(message, "IDEMPOTENCY_CONFLICT");
  }
}
