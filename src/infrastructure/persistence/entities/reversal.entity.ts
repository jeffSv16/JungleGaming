import { Entity, PrimaryKey, Property, Unique } from "@mikro-orm/core";

/**
 * Ensures a reference can only be reversed once per operation kind
 * (REFUND once, ROLLBACK once) — enforced by unique constraint.
 */
@Entity({ tableName: "transaction_reversals" })
@Unique({
  properties: ["referenceTransactionId", "reversalKind"],
  name: "uq_reversal_once_per_kind",
})
export class TransactionReversalEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "reference_transaction_id", type: "uuid" })
  referenceTransactionId!: string;

  /** REFUND or ROLLBACK */
  @Property({ fieldName: "reversal_kind", length: 32 })
  reversalKind!: string;

  @Property({ fieldName: "reversal_transaction_id", type: "uuid" })
  reversalTransactionId!: string;

  @Property({ fieldName: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
