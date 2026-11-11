import { Entity, PrimaryKey, Property, Unique, Index, Enum } from "@mikro-orm/core";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wager-transaction/wager-transaction";
import { FailureCode } from "../../../domain/shared/failure-code";

@Entity({ tableName: "wager_transactions" })
@Unique({
  properties: ["providerId", "externalTransactionId"],
  name: "uq_wager_provider_external",
})
@Unique({ properties: ["idempotencyKey"], name: "uq_wager_idempotency_key" })
@Index({
  properties: ["providerId", "referenceExternalTransactionId"],
  name: "idx_wager_reference",
})
@Index({ properties: ["status", "nextAttemptAt"], name: "idx_wager_pending_ref" })
export class WagerTransactionEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "provider_id", length: 128 })
  providerId!: string;

  @Property({ fieldName: "external_transaction_id", length: 256 })
  externalTransactionId!: string;

  @Property({ fieldName: "idempotency_key", length: 512 })
  idempotencyKey!: string;

  @Property({ fieldName: "payload_hash", length: 64 })
  payloadHash!: string;

  @Property({ fieldName: "wallet_id", type: "uuid" })
  walletId!: string;

  @Property({ fieldName: "player_id", type: "uuid" })
  playerId!: string;

  @Property({ fieldName: "round_id", length: 256 })
  roundId!: string;

  @Property({ fieldName: "game_id", length: 256 })
  gameId!: string;

  @Enum({ items: () => WagerTransactionKind, nativeEnumName: "wager_kind" })
  kind!: WagerTransactionKind;

  @Property({ fieldName: "money_amount", type: "numeric", precision: 20, scale: 2 })
  moneyAmount!: string;

  @Property({ fieldName: "money_currency", length: 3 })
  moneyCurrency!: string;

  @Property({
    fieldName: "reference_external_transaction_id",
    length: 256,
    nullable: true,
  })
  referenceExternalTransactionId?: string;

  @Property({ fieldName: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Enum({
    items: () => WagerTransactionStatus,
    nativeEnumName: "wager_status",
  })
  status!: WagerTransactionStatus;

  @Property({ fieldName: "reference_transaction_id", type: "uuid", nullable: true })
  referenceTransactionId?: string;

  @Enum({
    items: () => FailureCode,
    nativeEnumName: "failure_code",
    nullable: true,
  })
  failureCode?: FailureCode;

  @Property({ fieldName: "processed_at", type: "timestamptz", nullable: true })
  processedAt?: Date;

  @Property({
    fieldName: "observed_balance_amount",
    type: "numeric",
    precision: 20,
    scale: 2,
    nullable: true,
  })
  observedBalanceAmount?: string;

  @Property({ fieldName: "observed_balance_currency", length: 3, nullable: true })
  observedBalanceCurrency?: string;

  @Property({ fieldName: "attempt_count", type: "int", default: 0 })
  attemptCount: number = 0;

  @Property({ fieldName: "next_attempt_at", type: "timestamptz", nullable: true })
  nextAttemptAt?: Date;
}
