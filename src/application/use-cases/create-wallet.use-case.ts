import {
  Injectable,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import {
  EntityManager,
  UniqueConstraintViolationException,
} from "@mikro-orm/postgresql";
import { Money } from "../../domain/money/money";
import { Wallet } from "../../domain/wallet/wallet";
import { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../domain/ledger/wallet-ledger-entry";
import { OutboxMessage } from "../../domain/outbox/outbox-message";
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
} from "../../domain/events/integration-event";
import { newId } from "../../domain/shared/id";
import { WalletEntity } from "../../infrastructure/persistence/entities/wallet.entity";
import {
  mapDomainTxToEntity,
  mapLedgerToEntity,
  mapOutboxToEntity,
} from "../../infrastructure/persistence/mappers/wager.mapper";

export interface CreateWalletInput {
  playerId: string;
  initialBalance: { amount: string; currency: string };
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletOutput> {
    let initial: Money;
    try {
      initial = Money.from(input.initialBalance);
      initial.assertNonNegative("initialBalance");
    } catch (err) {
      throw new BadRequestException({
        code: "INVALID_PAYLOAD",
        message: err instanceof Error ? err.message : "Invalid money",
      });
    }

    const fork = this.em.fork();
    try {
      return await fork.transactional(async (tem) => {
        const now = new Date();
        const wallet = Wallet.open({
          id: newId(),
          playerId: input.playerId,
          initialBalance: initial,
          createdAt: now,
        });

        tem.persist(
          tem.create(WalletEntity, {
            id: wallet.id,
            playerId: wallet.playerId,
            currency: wallet.currency,
            balanceAmount: wallet.balance.toString(),
            version: wallet.version,
            createdAt: wallet.createdAt,
            updatedAt: wallet.updatedAt,
          }),
        );
        // Ensure wallet row exists before FK dependents (ledger / opening tx).
        await tem.flush();

        if (initial.isPositive()) {
          const opening = WagerTransaction.createOpening({
            id: newId(),
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: initial,
            createdAt: now,
          });
          tem.persist(mapDomainTxToEntity(opening));
          await tem.flush();

          const entry = WalletLedgerEntry.create({
            id: newId(),
            walletId: wallet.id,
            transactionId: opening.id,
            direction: LedgerDirection.Credit,
            money: initial,
            balanceBefore: Money.zero(wallet.currency),
            balanceAfter: initial,
            createdAt: now,
          });
          tem.persist(mapLedgerToEntity(entry));

          const correlationId = opening.id;
          for (const event of [
            WagerTransactionProcessed.from(opening, {
              eventId: newId(),
              correlationId,
              causationId: opening.id,
              occurredAt: now,
            }),
            WalletBalanceChanged.from(wallet, entry, {
              eventId: newId(),
              correlationId,
              causationId: opening.id,
              occurredAt: now,
            }),
          ]) {
            tem.persist(mapOutboxToEntity(OutboxMessage.enqueue(event)));
          }
        }

        await tem.flush();
        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (err) {
      if (err instanceof UniqueConstraintViolationException) {
        throw new ConflictException({
          code: "WALLET_CONFLICT",
          message: "Wallet already exists for playerId + currency",
        });
      }
      throw err;
    }
  }
}
