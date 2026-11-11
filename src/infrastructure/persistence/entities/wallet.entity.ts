import { Entity, PrimaryKey, Property, Unique, Check } from "@mikro-orm/core";

@Entity({ tableName: "wallets" })
@Unique({ properties: ["playerId", "currency"], name: "uq_wallets_player_currency" })
@Check({ name: "chk_wallets_balance_non_negative", expression: "balance_amount >= 0" })
@Check({ name: "chk_wallets_version_positive", expression: "version >= 1" })
export class WalletEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "player_id", type: "uuid" })
  playerId!: string;

  @Property({ length: 3 })
  currency!: string;

  /** Exact decimal as string — never float */
  @Property({ fieldName: "balance_amount", type: "numeric", precision: 20, scale: 2 })
  balanceAmount!: string;

  @Property({ type: "int" })
  version!: number;

  @Property({ fieldName: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Property({ fieldName: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
