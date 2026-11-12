import {
  WagerTransaction,
  type WagerTransactionState,
} from "../../../domain/wager-transaction/wager-transaction";
import { Wallet } from "../../../domain/wallet/wallet";
import {
  WalletLedgerEntry,
  LedgerDirection,
} from "../../../domain/ledger/wallet-ledger-entry";
import { OutboxMessage } from "../../../domain/outbox/outbox-message";
import { InboxMessage } from "../../../domain/inbox/inbox-message";
import { WalletEntity } from "../entities/wallet.entity";
import { WagerTransactionEntity } from "../entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "../entities/wallet-ledger-entry.entity";
import { OutboxMessageEntity } from "../entities/outbox-message.entity";
import { InboxMessageEntity } from "../entities/inbox-message.entity";
import { formatNumeric } from "./numeric";

export function mapWalletEntityToDomain(e: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: e.id,
    playerId: e.playerId,
    currency: e.currency,
    balance: { amount: formatNumeric(e.balanceAmount), currency: e.currency },
    version: e.version,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  });
}

export function applyWalletToEntity(wallet: Wallet, e: WalletEntity): void {
  e.balanceAmount = wallet.balance.toString();
  e.version = wallet.version;
  e.updatedAt = wallet.updatedAt;
}

export function mapDomainTxToEntity(tx: WagerTransaction): WagerTransactionEntity {
  const s = tx.toState();
  const e = new WagerTransactionEntity();
  applyTxStateToEntity(s, e);
  return e;
}

export function applyTxStateToEntity(
  s: WagerTransactionState,
  e: WagerTransactionEntity,
): void {
  e.id = s.id;
  e.providerId = s.providerId;
  e.externalTransactionId = s.externalTransactionId;
  e.idempotencyKey = s.idempotencyKey;
  e.payloadHash = s.payloadHash;
  e.walletId = s.walletId;
  e.playerId = s.playerId;
  e.roundId = s.roundId;
  e.gameId = s.gameId;
  e.kind = s.kind;
  e.moneyAmount = s.money.amount;
  e.moneyCurrency = s.money.currency;
  e.referenceExternalTransactionId = s.referenceExternalTransactionId;
  e.createdAt = s.createdAt;
  e.status = s.status;
  e.referenceTransactionId = s.referenceTransactionId;
  e.failureCode = s.failureCode;
  e.processedAt = s.processedAt;
  e.observedBalanceAmount = s.observedBalance?.amount;
  e.observedBalanceCurrency = s.observedBalance?.currency;
  e.attemptCount = s.attemptCount;
  e.nextAttemptAt = s.nextAttemptAt;
}

export function mapTxEntityToDomain(e: WagerTransactionEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: e.id,
    providerId: e.providerId,
    externalTransactionId: e.externalTransactionId,
    idempotencyKey: e.idempotencyKey,
    payloadHash: e.payloadHash,
    walletId: e.walletId,
    playerId: e.playerId,
    roundId: e.roundId,
    gameId: e.gameId,
    kind: e.kind,
    money: {
      amount: formatNumeric(e.moneyAmount),
      currency: e.moneyCurrency,
    },
    referenceExternalTransactionId: e.referenceExternalTransactionId,
    createdAt: e.createdAt,
    status: e.status,
    referenceTransactionId: e.referenceTransactionId,
    failureCode: e.failureCode,
    processedAt: e.processedAt,
    observedBalance:
      e.observedBalanceAmount && e.observedBalanceCurrency
        ? {
            amount: formatNumeric(e.observedBalanceAmount),
            currency: e.observedBalanceCurrency,
          }
        : undefined,
    attemptCount: e.attemptCount,
    nextAttemptAt: e.nextAttemptAt,
  });
}

export function mapLedgerToEntity(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
  const e = new WalletLedgerEntryEntity();
  e.id = entry.id;
  e.walletId = entry.walletId;
  e.transactionId = entry.transactionId;
  e.direction = entry.direction;
  e.moneyAmount = entry.money.toString();
  e.moneyCurrency = entry.money.currency;
  e.balanceBeforeAmount = entry.balanceBefore.toString();
  e.balanceBeforeCurrency = entry.balanceBefore.currency;
  e.balanceAfterAmount = entry.balanceAfter.toString();
  e.balanceAfterCurrency = entry.balanceAfter.currency;
  e.createdAt = entry.createdAt;
  return e;
}

export function mapLedgerEntityToDomain(
  e: WalletLedgerEntryEntity,
): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction as LedgerDirection,
    money: {
      amount: formatNumeric(e.moneyAmount),
      currency: e.moneyCurrency,
    },
    balanceBefore: {
      amount: formatNumeric(e.balanceBeforeAmount),
      currency: e.balanceBeforeCurrency,
    },
    balanceAfter: {
      amount: formatNumeric(e.balanceAfterAmount),
      currency: e.balanceAfterCurrency,
    },
    createdAt: e.createdAt,
  });
}

export function mapOutboxToEntity(msg: OutboxMessage): OutboxMessageEntity {
  const e = new OutboxMessageEntity();
  e.id = msg.id;
  e.aggregateId = msg.aggregateId;
  e.eventType = msg.eventType;
  e.payload = { ...msg.payload };
  e.occurredAt = msg.occurredAt;
  e.attempts = msg.attempts;
  e.nextAttemptAt = msg.nextAttemptAt;
  e.publishedAt = msg.publishedAt;
  return e;
}

export function mapInboxToEntity(
  msg: InboxMessage,
  id: string,
): InboxMessageEntity {
  const e = new InboxMessageEntity();
  e.id = id;
  e.messageId = msg.messageId;
  e.consumerName = msg.consumerName;
  e.payloadHash = msg.payloadHash;
  e.receivedAt = msg.receivedAt;
  e.processedAt = msg.processedAt;
  return e;
}
