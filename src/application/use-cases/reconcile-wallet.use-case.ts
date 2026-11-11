import { Injectable, NotFoundException } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import Decimal from "decimal.js";
import { WalletEntity } from "../../infrastructure/persistence/entities/wallet.entity";
import { WalletLedgerEntryEntity } from "../../infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { LedgerDirection } from "../../domain/ledger/wallet-ledger-entry";
import { formatNumeric } from "../../infrastructure/persistence/mappers/numeric";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { AppLogger } from "../../infrastructure/observability/logger.service";

export interface ReconciliationResult {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const fork = this.em.fork();
    const wallet = await fork.findOne(WalletEntity, { id: walletId });
    if (!wallet) {
      throw new NotFoundException({
        code: "WALLET_NOT_FOUND",
        message: "Wallet not found",
      });
    }

    const entries = await fork.find(
      WalletLedgerEntryEntity,
      { walletId },
      { orderBy: { createdAt: "ASC", id: "ASC" } },
    );

    let calculated = new Decimal(0);
    for (const entry of entries) {
      const amount = new Decimal(String(entry.moneyAmount));
      if (entry.direction === LedgerDirection.Credit) {
        calculated = calculated.plus(amount);
      } else {
        calculated = calculated.minus(amount);
      }
    }

    const stored = new Decimal(String(wallet.balanceAmount));
    const diff = stored.minus(calculated);
    const consistent = diff.isZero();

    if (!consistent) {
      this.metrics.reconciliationDivergences.inc();
      this.logger.error("wallet_reconciliation_divergence", {
        walletId,
        storedBalance: formatNumeric(wallet.balanceAmount),
        calculatedBalance: calculated.toFixed(2),
        checkedEntries: entries.length,
      });
    }

    return {
      walletId,
      storedBalance: {
        amount: formatNumeric(wallet.balanceAmount),
        currency: wallet.currency,
      },
      calculatedBalance: {
        amount: calculated.toFixed(2),
        currency: wallet.currency,
      },
      difference: {
        amount: diff.toFixed(2),
        currency: wallet.currency,
      },
      consistent,
      checkedEntries: entries.length,
    };
  }
}
