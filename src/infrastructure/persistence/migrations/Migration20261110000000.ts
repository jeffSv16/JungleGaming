import { Migration } from "@mikro-orm/migrations";

export class Migration20261110000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TYPE wager_kind AS ENUM ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK');
      CREATE TYPE wager_status AS ENUM ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED');
      CREATE TYPE ledger_direction AS ENUM ('DEBIT','CREDIT');
      CREATE TYPE failure_code AS ENUM (
        'INSUFFICIENT_BALANCE','NEGATIVE_BALANCE_ON_REVERSAL','CURRENCY_MISMATCH',
        'WALLET_NOT_FOUND','PLAYER_WALLET_MISMATCH','IDEMPOTENCY_CONFLICT',
        'INVALID_PAYLOAD','INVALID_KIND','OPENING_NOT_ALLOWED','MISSING_REFERENCE',
        'REFERENCE_NOT_FOUND','REFERENCE_NOT_PROCESSED','REFERENCE_SCOPE_MISMATCH',
        'INVALID_REFERENCE_KIND','ALREADY_REVERSED','AMOUNT_MISMATCH',
        'REFERENCE_TIMEOUT','PERMANENT_INFRASTRUCTURE'
      );

      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_amount NUMERIC(20,2) NOT NULL,
        version INT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT chk_wallets_version_positive CHECK (version >= 1)
      );

      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(128) NOT NULL,
        external_transaction_id VARCHAR(256) NOT NULL,
        idempotency_key VARCHAR(512) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id UUID NOT NULL,
        round_id VARCHAR(256) NOT NULL,
        game_id VARCHAR(256) NOT NULL,
        kind wager_kind NOT NULL,
        money_amount NUMERIC(20,2) NOT NULL,
        money_currency CHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(256) NULL,
        created_at TIMESTAMPTZ NOT NULL,
        status wager_status NOT NULL,
        reference_transaction_id UUID NULL,
        failure_code failure_code NULL,
        processed_at TIMESTAMPTZ NULL,
        observed_balance_amount NUMERIC(20,2) NULL,
        observed_balance_currency CHAR(3) NULL,
        attempt_count INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NULL,
        CONSTRAINT uq_wager_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT chk_wager_money_non_negative CHECK (money_amount >= 0)
      );
      CREATE INDEX idx_wager_reference ON wager_transactions (provider_id, reference_external_transaction_id);
      CREATE INDEX idx_wager_pending_ref ON wager_transactions (status, next_attempt_at);

      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
        direction ledger_direction NOT NULL,
        money_amount NUMERIC(20,2) NOT NULL,
        money_currency CHAR(3) NOT NULL,
        balance_before_amount NUMERIC(20,2) NOT NULL,
        balance_before_currency CHAR(3) NOT NULL,
        balance_after_amount NUMERIC(20,2) NOT NULL,
        balance_after_currency CHAR(3) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_ledger_transaction UNIQUE (transaction_id),
        CONSTRAINT chk_ledger_amounts_non_negative CHECK (
          money_amount >= 0 AND balance_before_amount >= 0 AND balance_after_amount >= 0
        ),
        CONSTRAINT chk_ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_after_amount = balance_before_amount + money_amount)
          OR
          (direction = 'DEBIT' AND balance_after_amount = balance_before_amount - money_amount)
        )
      );
      CREATE INDEX idx_ledger_wallet_cursor ON wallet_ledger_entries (wallet_id, created_at, id);

      CREATE TABLE inbox_messages (
        id UUID PRIMARY KEY,
        message_id VARCHAR(256) NOT NULL,
        consumer_name VARCHAR(128) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ NULL,
        CONSTRAINT uq_inbox_consumer_message UNIQUE (consumer_name, message_id)
      );

      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NULL,
        published_at TIMESTAMPTZ NULL
      );
      CREATE INDEX idx_outbox_due ON outbox_messages (published_at, next_attempt_at);

      CREATE TABLE transaction_reversals (
        id UUID PRIMARY KEY,
        reference_transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
        reversal_kind VARCHAR(32) NOT NULL,
        reversal_transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_reversal_once_per_kind UNIQUE (reference_transaction_id, reversal_kind)
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TABLE IF EXISTS transaction_reversals;
      DROP TABLE IF EXISTS outbox_messages;
      DROP TABLE IF EXISTS inbox_messages;
      DROP TABLE IF EXISTS wallet_ledger_entries;
      DROP TABLE IF EXISTS wager_transactions;
      DROP TABLE IF EXISTS wallets;
      DROP TYPE IF EXISTS failure_code;
      DROP TYPE IF EXISTS ledger_direction;
      DROP TYPE IF EXISTS wager_status;
      DROP TYPE IF EXISTS wager_kind;
    `);
  }
}
