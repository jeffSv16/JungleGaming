import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Enum,
  Index,
  Check,
} from "@mikro-orm/core";
import { LedgerDirection } from "../../../domain/ledger/wallet-ledger-entry";

@Entity({ tableName: "wallet_ledger_entries" })
@Unique({
  properties: ["transactionId"],
  name: "uq_ledger_transaction",
})
@Index({ properties: ["walletId", "createdAt", "id"], name: "idx_ledger_wallet_cursor" })
@Check({
  name: "chk_ledger_amounts_non_negative",
  expression:
    "money_amount >= 0 AND balance_before_amount >= 0 AND balance_after_amount >= 0",
})
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "wallet_id", type: "uuid" })
  walletId!: string;

  @Property({ fieldName: "transaction_id", type: "uuid" })
  transactionId!: string;

  @Enum({ items: () => LedgerDirection, nativeEnumName: "ledger_direction" })
  direction!: LedgerDirection;

  @Property({ fieldName: "money_amount", type: "numeric", precision: 20, scale: 2 })
  moneyAmount!: string;

  @Property({ fieldName: "money_currency", length: 3 })
  moneyCurrency!: string;

  @Property({
    fieldName: "balance_before_amount",
    type: "numeric",
    precision: 20,
    scale: 2,
  })
  balanceBeforeAmount!: string;

  @Property({ fieldName: "balance_before_currency", length: 3 })
  balanceBeforeCurrency!: string;

  @Property({
    fieldName: "balance_after_amount",
    type: "numeric",
    precision: 20,
    scale: 2,
  })
  balanceAfterAmount!: string;

  @Property({ fieldName: "balance_after_currency", length: 3 })
  balanceAfterCurrency!: string;

  @Property({ fieldName: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
