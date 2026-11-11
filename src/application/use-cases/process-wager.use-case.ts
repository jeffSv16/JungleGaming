import { Injectable } from "@nestjs/common";
import {
  DeadlockException,
  EntityManager,
  LockMode,
  UniqueConstraintViolationException,
} from "@mikro-orm/postgresql";
import { Money } from "../../domain/money/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction/wager-transaction";
import { LedgerDirection } from "../../domain/ledger/wallet-ledger-entry";
import { OutboxMessage } from "../../domain/outbox/outbox-message";
import { InboxMessage } from "../../domain/inbox/inbox-message";
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../domain/events/integration-event";
import { FailureCode } from "../../domain/shared/failure-code";
import { newId } from "../../domain/shared/id";
import {
  computePayloadHash,
  wagerBusinessPayload,
} from "../../domain/shared/payload-hash";
import {
  InsufficientBalanceError,
  NegativeBalanceError,
  CurrencyMismatchError,
  IdempotencyConflictError,
} from "../../domain/shared/domain-error";
import { WalletEntity } from "../../infrastructure/persistence/entities/wallet.entity";
import { WagerTransactionEntity } from "../../infrastructure/persistence/entities/wager-transaction.entity";
import { TransactionReversalEntity } from "../../infrastructure/persistence/entities/reversal.entity";
import { InboxMessageEntity } from "../../infrastructure/persistence/entities/inbox-message.entity";
import {
  applyTxStateToEntity,
  applyWalletToEntity,
  mapDomainTxToEntity,
  mapLedgerToEntity,
  mapOutboxToEntity,
  mapTxEntityToDomain,
  mapWalletEntityToDomain,
  mapInboxToEntity,
} from "../../infrastructure/persistence/mappers/wager.mapper";
import { MetricsService } from "../../infrastructure/observability/metrics.service";

/** Max attempts for PENDING_REFERENCE before REFERENCE_TIMEOUT rejection. */
export const PENDING_REFERENCE_MAX_ATTEMPTS = 8;
const PENDING_REFERENCE_BASE_BACKOFF_MS = 500;

export interface ProcessWagerInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind | string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  /** When present, inbox row is written in the same SQL transaction. */
  inbox?: { messageId: string; consumerName: string };
  correlationId?: string;
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: { amount: string; currency: string };
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
  ) {}

  async execute(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    const started = Date.now();
    const payloadHash = computePayloadHash(
      wagerBusinessPayload({
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: String(input.kind),
        money: input.money,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
      }),
    );

    const maxAttempts = 5;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.executeOnce(input, payloadHash);
        this.metrics.processingLatency.observe(
          { kind: String(input.kind) },
          (Date.now() - started) / 1000,
        );
        this.metrics.transactions.inc({
          status: result.status,
          kind: String(input.kind),
        });
        return result;
      } catch (err) {
        lastError = err;
        if (err instanceof IdempotencyConflictError) {
          throw err;
        }
        if (err instanceof UniqueConstraintViolationException) {
          const again = await this.em.fork().findOne(WagerTransactionEntity, {
            idempotencyKey: input.idempotencyKey,
          });
          if (again) {
            if (again.payloadHash !== payloadHash) {
              throw new IdempotencyConflictError();
            }
            return this.toResult(mapTxEntityToDomain(again), true);
          }
        }
        if (err instanceof DeadlockException && attempt < maxAttempts) {
          this.metrics.lockConflicts.inc({ reason: "deadlock_retry" });
          this.metrics.retries.inc({ component: "deadlock" });
          await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 20));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  private async executeOnce(
    input: ProcessWagerInput,
    payloadHash: string,
  ): Promise<ProcessWagerResult> {
    const fork = this.em.fork();
    return fork.transactional(async (tem) => {
      // Inbox dedup (SQS path)
      if (input.inbox) {
        const existingInbox = await tem.findOne(InboxMessageEntity, {
          consumerName: input.inbox.consumerName,
          messageId: input.inbox.messageId,
        });
        if (existingInbox?.processedAt) {
          this.metrics.duplicates.inc({ source: "inbox" });
          const prior = await tem.findOne(WagerTransactionEntity, {
            idempotencyKey: input.idempotencyKey,
          });
          if (prior) {
            return this.toResult(mapTxEntityToDomain(prior), true);
          }
        }
      }

      // Idempotency
      const existing = await tem.findOne(WagerTransactionEntity, {
        idempotencyKey: input.idempotencyKey,
      });
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          this.metrics.duplicates.inc({ source: "idempotency_conflict" });
          throw new IdempotencyConflictError();
        }
        this.metrics.duplicates.inc({ source: "idempotency_replay" });
        const domain = mapTxEntityToDomain(existing);
        if (
          domain.status === WagerTransactionStatus.PendingReference ||
          domain.status === WagerTransactionStatus.Pending
        ) {
          return this.processExisting(tem, domain, existing, input);
        }
        return this.toResult(domain, true);
      }

      let money: Money;
      let kind: WagerTransactionKind;
      try {
        money = Money.from(input.money);
        money.assertNonNegative("money");
        kind = this.parseKind(input.kind);
      } catch {
        throw Object.assign(new Error("INVALID_PAYLOAD"), {
          failureCode: FailureCode.InvalidPayload,
        });
      }

      if (kind === WagerTransactionKind.Opening) {
        throw Object.assign(new Error("OPENING_NOT_ALLOWED"), {
          failureCode: FailureCode.OpeningNotAllowed,
        });
      }

      // Lock wallet BEFORE inserting rows that FK-reference it.
      // Avoids ShareLock(FK) → Exclusive(FOR UPDATE) upgrade deadlocks.
      await tem.findOne(
        WalletEntity,
        { id: input.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      const tx = WagerTransaction.create({
        id: newId(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind,
        money,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
      });

      const txEntity = mapDomainTxToEntity(tx);
      tem.persist(txEntity);
      await tem.flush();

      if (input.inbox) {
        const inbox = InboxMessage.receive({
          messageId: input.inbox.messageId,
          consumerName: input.inbox.consumerName,
          payloadHash,
        });
        tem.persist(mapInboxToEntity(inbox, newId()));
      }

      const result = await this.applyTransaction(tem, tx, txEntity, input);

      if (input.inbox) {
        const inboxRow = await tem.findOneOrFail(InboxMessageEntity, {
          consumerName: input.inbox.consumerName,
          messageId: input.inbox.messageId,
        });
        inboxRow.processedAt = new Date();
      }

      await tem.flush();
      return result;
    });
  }

  /** Reprocess a PENDING_REFERENCE transaction (worker). */
  async reprocess(transactionId: string): Promise<ProcessWagerResult> {
    const fork = this.em.fork();
    return fork.transactional(async (tem) => {
      const entity = await tem.findOne(
        WagerTransactionEntity,
        { id: transactionId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!entity) {
        throw new Error(`Transaction not found: ${transactionId}`);
      }
      const tx = mapTxEntityToDomain(entity);
      if (tx.isTerminal()) {
        return this.toResult(tx, true);
      }
      return this.processExisting(tem, tx, entity, {
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        idempotencyKey: tx.idempotencyKey,
        playerId: tx.playerId,
        walletId: tx.walletId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        correlationId: tx.id,
      });
    });
  }

  private async processExisting(
    tem: EntityManager,
    tx: WagerTransaction,
    entity: WagerTransactionEntity,
    input: ProcessWagerInput,
  ): Promise<ProcessWagerResult> {
    const result = await this.applyTransaction(tem, tx, entity, input);
    await tem.flush();
    return result;
  }

  private async applyTransaction(
    tem: EntityManager,
    tx: WagerTransaction,
    entity: WagerTransactionEntity,
    input: ProcessWagerInput,
  ): Promise<ProcessWagerResult> {
    const now = new Date();
    const correlationId = input.correlationId ?? tx.id;

    // Lock wallet — concurrency unit is walletId
    const walletEntity = await tem.findOne(
      WalletEntity,
      { id: tx.walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (!walletEntity) {
      tx.reject(FailureCode.WalletNotFound);
      applyTxStateToEntity(tx.toState(), entity);
      this.enqueueRejected(tem, tx, correlationId, now);
      return this.toResult(tx, false);
    }

    const wallet = mapWalletEntityToDomain(walletEntity);

    if (wallet.playerId !== tx.playerId) {
      tx.reject(FailureCode.PlayerWalletMismatch, wallet.balance);
      applyTxStateToEntity(tx.toState(), entity);
      applyWalletToEntity(wallet, walletEntity);
      this.enqueueRejected(tem, tx, correlationId, now);
      return this.toResult(tx, false);
    }

    if (tx.money.currency !== wallet.currency) {
      tx.reject(FailureCode.CurrencyMismatch, wallet.balance);
      applyTxStateToEntity(tx.toState(), entity);
      this.enqueueRejected(tem, tx, correlationId, now);
      return this.toResult(tx, false);
    }

    // Resolve reference for REFUND / ROLLBACK (and optional WIN)
    let reference: WagerTransaction | undefined;
    if (tx.requiresReference() || tx.referenceExternalTransactionId) {
      const refEntity = tx.referenceExternalTransactionId
        ? await tem.findOne(WagerTransactionEntity, {
            providerId: tx.providerId,
            externalTransactionId: tx.referenceExternalTransactionId,
          })
        : null;

      if (!refEntity) {
        if (tx.requiresReference()) {
          if (tx.attemptCount + 1 >= PENDING_REFERENCE_MAX_ATTEMPTS) {
            tx.reject(FailureCode.ReferenceTimeout, wallet.balance);
            applyTxStateToEntity(tx.toState(), entity);
            this.enqueueRejected(tem, tx, correlationId, now);
            return this.toResult(tx, false);
          }
          const backoff =
            PENDING_REFERENCE_BASE_BACKOFF_MS * 2 ** Math.min(tx.attemptCount, 6);
          tx.markPendingReference(now, backoff);
          applyTxStateToEntity(tx.toState(), entity);
          const event = WagerTransactionPendingReference.from(tx, {
            eventId: newId(),
            correlationId,
            causationId: tx.id,
            occurredAt: now,
          });
          tem.persist(mapOutboxToEntity(OutboxMessage.enqueue(event)));
          return this.toResult(tx, false);
        }
      } else {
        reference = mapTxEntityToDomain(refEntity);
        const scopeOk =
          reference.providerId === tx.providerId &&
          reference.playerId === tx.playerId &&
          reference.walletId === tx.walletId &&
          reference.money.currency === tx.money.currency &&
          reference.roundId === tx.roundId;
        if (!scopeOk) {
          tx.reject(FailureCode.ReferenceScopeMismatch, wallet.balance);
          applyTxStateToEntity(tx.toState(), entity);
          this.enqueueRejected(tem, tx, correlationId, now);
          return this.toResult(tx, false);
        }
        if (reference.status !== WagerTransactionStatus.Processed) {
          if (tx.requiresReference()) {
            if (tx.attemptCount + 1 >= PENDING_REFERENCE_MAX_ATTEMPTS) {
              tx.reject(FailureCode.ReferenceNotProcessed, wallet.balance);
              applyTxStateToEntity(tx.toState(), entity);
              this.enqueueRejected(tem, tx, correlationId, now);
              return this.toResult(tx, false);
            }
            const backoff =
              PENDING_REFERENCE_BASE_BACKOFF_MS *
              2 ** Math.min(tx.attemptCount, 6);
            tx.markPendingReference(now, backoff);
            applyTxStateToEntity(tx.toState(), entity);
            const event = WagerTransactionPendingReference.from(tx, {
              eventId: newId(),
              correlationId,
              causationId: tx.id,
              occurredAt: now,
            });
            tem.persist(mapOutboxToEntity(OutboxMessage.enqueue(event)));
            return this.toResult(tx, false);
          }
        }

        if (tx.kind === WagerTransactionKind.Refund) {
          if (reference.kind !== WagerTransactionKind.Bet) {
            tx.reject(FailureCode.InvalidReferenceKind, wallet.balance);
            applyTxStateToEntity(tx.toState(), entity);
            this.enqueueRejected(tem, tx, correlationId, now);
            return this.toResult(tx, false);
          }
        }
        if (tx.kind === WagerTransactionKind.Rollback) {
          const allowed = [
            WagerTransactionKind.Bet,
            WagerTransactionKind.Win,
            WagerTransactionKind.Refund,
          ];
          if (!allowed.includes(reference.kind)) {
            tx.reject(FailureCode.InvalidReferenceKind, wallet.balance);
            applyTxStateToEntity(tx.toState(), entity);
            this.enqueueRejected(tem, tx, correlationId, now);
            return this.toResult(tx, false);
          }
        }
        if (
          tx.kind === WagerTransactionKind.Refund ||
          tx.kind === WagerTransactionKind.Rollback
        ) {
          if (!tx.money.equals(reference.money)) {
            tx.reject(FailureCode.AmountMismatch, wallet.balance);
            applyTxStateToEntity(tx.toState(), entity);
            this.enqueueRejected(tem, tx, correlationId, now);
            return this.toResult(tx, false);
          }
        }
      }
    }

    // Apply balance effects
    try {
      if (tx.kind === WagerTransactionKind.Loss) {
        tx.markProcessed(reference?.id, now, wallet.balance);
        applyTxStateToEntity(tx.toState(), entity);
        this.enqueueProcessed(tem, tx, correlationId, now);
        return this.toResult(tx, false);
      }

      if (tx.kind === WagerTransactionKind.Bet) {
        const { entry } = wallet.debit({
          entryId: newId(),
          transactionId: tx.id,
          money: tx.money,
          at: now,
        });
        applyWalletToEntity(wallet, walletEntity);
        tx.markProcessed(undefined, now, wallet.balance);
        applyTxStateToEntity(tx.toState(), entity);
        await tem.flush();
        tem.persist(mapLedgerToEntity(entry));
        this.enqueueProcessed(tem, tx, correlationId, now);
        this.enqueueBalanceChanged(tem, wallet, entry, correlationId, now);
        return this.toResult(tx, false);
      }

      if (
        tx.kind === WagerTransactionKind.Win ||
        tx.kind === WagerTransactionKind.Refund
      ) {
        if (tx.kind === WagerTransactionKind.Refund && reference) {
          await this.claimReversal(tem, reference.id, "REFUND", tx.id, now);
        }
        const { entry } = wallet.credit({
          entryId: newId(),
          transactionId: tx.id,
          money: tx.money,
          at: now,
        });
        applyWalletToEntity(wallet, walletEntity);
        tx.markProcessed(reference?.id, now, wallet.balance);
        applyTxStateToEntity(tx.toState(), entity);
        await tem.flush();
        tem.persist(mapLedgerToEntity(entry));
        this.enqueueProcessed(tem, tx, correlationId, now);
        this.enqueueBalanceChanged(tem, wallet, entry, correlationId, now);
        return this.toResult(tx, false);
      }

      if (tx.kind === WagerTransactionKind.Rollback) {
        if (!reference) {
          tx.reject(FailureCode.ReferenceNotFound, wallet.balance);
          applyTxStateToEntity(tx.toState(), entity);
          this.enqueueRejected(tem, tx, correlationId, now);
          return this.toResult(tx, false);
        }
        await this.claimReversal(tem, reference.id, "ROLLBACK", tx.id, now);
        const originalDir = reference.ledgerDirectionFor();
        if (originalDir === null) {
          // Reference had no balance effect — just mark processed
          tx.markProcessed(reference.id, now, wallet.balance);
          applyTxStateToEntity(tx.toState(), entity);
          this.enqueueProcessed(tem, tx, correlationId, now);
          return this.toResult(tx, false);
        }
        const { entry } = wallet.applyInverse({
          entryId: newId(),
          transactionId: tx.id,
          originalDirection: originalDir,
          money: tx.money,
          at: now,
        });
        applyWalletToEntity(wallet, walletEntity);
        tx.markProcessed(reference.id, now, wallet.balance);
        applyTxStateToEntity(tx.toState(), entity);
        await tem.flush();
        tem.persist(mapLedgerToEntity(entry));
        this.enqueueProcessed(tem, tx, correlationId, now);
        this.enqueueBalanceChanged(tem, wallet, entry, correlationId, now);
        return this.toResult(tx, false);
      }

      tx.reject(FailureCode.InvalidKind, wallet.balance);
      applyTxStateToEntity(tx.toState(), entity);
      this.enqueueRejected(tem, tx, correlationId, now);
      return this.toResult(tx, false);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        tx.reject(FailureCode.InsufficientBalance, wallet.balance);
        applyTxStateToEntity(tx.toState(), entity);
        this.enqueueRejected(tem, tx, correlationId, now);
        this.metrics.lockConflicts.inc({ reason: "insufficient_balance" });
        return this.toResult(tx, false);
      }
      if (err instanceof NegativeBalanceError) {
        tx.reject(FailureCode.NegativeBalanceOnReversal, wallet.balance);
        applyTxStateToEntity(tx.toState(), entity);
        this.enqueueRejected(tem, tx, correlationId, now);
        return this.toResult(tx, false);
      }
      if (err instanceof CurrencyMismatchError) {
        tx.reject(FailureCode.CurrencyMismatch, wallet.balance);
        applyTxStateToEntity(tx.toState(), entity);
        this.enqueueRejected(tem, tx, correlationId, now);
        return this.toResult(tx, false);
      }
      if (
        err instanceof UniqueConstraintViolationException ||
        (err instanceof Error &&
          (err.message.includes("uq_reversal_once_per_kind") ||
            (err as Error & { code?: string }).code === "ALREADY_REVERSED"))
      ) {
        tx.reject(FailureCode.AlreadyReversed, wallet.balance);
        applyTxStateToEntity(tx.toState(), entity);
        this.enqueueRejected(tem, tx, correlationId, now);
        return this.toResult(tx, false);
      }
      throw err;
    }
  }

  private async claimReversal(
    tem: EntityManager,
    referenceTransactionId: string,
    reversalKind: string,
    reversalTransactionId: string,
    at: Date,
  ): Promise<void> {
    const existing = await tem.findOne(TransactionReversalEntity, {
      referenceTransactionId,
      reversalKind,
    });
    if (existing) {
      const err = new Error("uq_reversal_once_per_kind");
      (err as Error & { code: string }).code = "ALREADY_REVERSED";
      throw err;
    }
    tem.persist(
      tem.create(TransactionReversalEntity, {
        id: newId(),
        referenceTransactionId,
        reversalKind,
        reversalTransactionId,
        createdAt: at,
      }),
    );
  }

  private enqueueProcessed(
    tem: EntityManager,
    tx: WagerTransaction,
    correlationId: string,
    now: Date,
  ): void {
    const event = WagerTransactionProcessed.from(tx, {
      eventId: newId(),
      correlationId,
      causationId: tx.id,
      occurredAt: now,
    });
    tem.persist(mapOutboxToEntity(OutboxMessage.enqueue(event)));
  }

  private enqueueRejected(
    tem: EntityManager,
    tx: WagerTransaction,
    correlationId: string,
    now: Date,
  ): void {
    const event = WagerTransactionRejected.from(tx, {
      eventId: newId(),
      correlationId,
      causationId: tx.id,
      occurredAt: now,
    });
    tem.persist(mapOutboxToEntity(OutboxMessage.enqueue(event)));
  }

  private enqueueBalanceChanged(
    tem: EntityManager,
    wallet: ReturnType<typeof mapWalletEntityToDomain>,
    entry: ReturnType<typeof mapLedgerToEntity> extends infer _T
      ? import("../../domain/ledger/wallet-ledger-entry").WalletLedgerEntry
      : never,
    correlationId: string,
    now: Date,
  ): void {
    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId: newId(),
      correlationId,
      causationId: entry.transactionId,
      occurredAt: now,
    });
    tem.persist(mapOutboxToEntity(OutboxMessage.enqueue(event)));
  }

  private parseKind(kind: string | WagerTransactionKind): WagerTransactionKind {
    const value = String(kind).toUpperCase();
    if (
      !Object.values(WagerTransactionKind).includes(
        value as WagerTransactionKind,
      )
    ) {
      throw new Error("INVALID_KIND");
    }
    return value as WagerTransactionKind;
  }

  private toResult(
    tx: WagerTransaction,
    idempotentReplay: boolean,
  ): ProcessWagerResult {
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: tx.observedBalance?.toJSON(),
      failureCode: tx.failureCode,
      idempotentReplay,
    };
  }
}
