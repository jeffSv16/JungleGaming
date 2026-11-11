import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { WalletEntity } from "./infrastructure/persistence/entities/wallet.entity";
import { WagerTransactionEntity } from "./infrastructure/persistence/entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "./infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { InboxMessageEntity } from "./infrastructure/persistence/entities/inbox-message.entity";
import { OutboxMessageEntity } from "./infrastructure/persistence/entities/outbox-message.entity";
import { TransactionReversalEntity } from "./infrastructure/persistence/entities/reversal.entity";
import { CreateWalletUseCase } from "./application/use-cases/create-wallet.use-case";
import { ProcessWagerUseCase } from "./application/use-cases/process-wager.use-case";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet.use-case";
import { WalletsController } from "./interfaces/http/wallets/wallets.controller";
import { WageringController } from "./interfaces/http/wagering/wagering.controller";
import { HealthController } from "./interfaces/http/health/health.controller";
import { MetricsService } from "./infrastructure/observability/metrics.service";
import { AppLogger } from "./infrastructure/observability/logger.service";
import { SqsService } from "./infrastructure/messaging/sqs.client";
import { WagerSqsConsumer } from "./interfaces/workers/wager-sqs.consumer";
import { OutboxPublisher } from "./interfaces/workers/outbox.publisher";
import { PendingReferenceWorker } from "./interfaces/workers/pending-reference.worker";
import {
  NoopAuthGuard,
  NoopProviderIdentity,
} from "./infrastructure/auth/noop-auth.guard";
import { Migrator } from "@mikro-orm/migrations";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MikroOrmModule.forRoot({
      driver: PostgreSqlDriver,
      host: process.env.POSTGRES_HOST ?? "127.0.0.1",
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USER ?? "wager",
      password: process.env.POSTGRES_PASSWORD ?? "wager",
      dbName: process.env.POSTGRES_DB ?? "wagering",
      entities: [
        WalletEntity,
        WagerTransactionEntity,
        WalletLedgerEntryEntity,
        InboxMessageEntity,
        OutboxMessageEntity,
        TransactionReversalEntity,
      ],
      extensions: [Migrator],
      migrations: {
        path: "dist/infrastructure/persistence/migrations",
        pathTs: "src/infrastructure/persistence/migrations",
      },
      allowGlobalContext: true,
    }),
    MikroOrmModule.forFeature([
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      InboxMessageEntity,
      OutboxMessageEntity,
      TransactionReversalEntity,
    ]),
  ],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    CreateWalletUseCase,
    ProcessWagerUseCase,
    ReconcileWalletUseCase,
    MetricsService,
    AppLogger,
    SqsService,
    WagerSqsConsumer,
    OutboxPublisher,
    PendingReferenceWorker,
    NoopAuthGuard,
    NoopProviderIdentity,
  ],
})
export class AppModule {}
