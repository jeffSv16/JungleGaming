import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { WagerTransactionEntity } from "../../infrastructure/persistence/entities/wager-transaction.entity";
import { WagerTransactionStatus } from "../../domain/wager-transaction/wager-transaction";
import { ProcessWagerUseCase } from "../../application/use-cases/process-wager.use-case";
import { AppLogger } from "../../infrastructure/observability/logger.service";
import { MetricsService } from "../../infrastructure/observability/metrics.service";

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    private readonly processWager: ProcessWagerUseCase,
    private readonly logger: AppLogger,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_WORKERS === "true") return;
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const due = await this.em.fork().find(
          WagerTransactionEntity,
          {
            status: WagerTransactionStatus.PendingReference,
            nextAttemptAt: { $lte: new Date() },
          },
          { limit: 20, orderBy: { nextAttemptAt: "ASC" } },
        );
        for (const row of due) {
          try {
            await this.processWager.reprocess(row.id);
          } catch (err) {
            this.metrics.retries.inc({ component: "pending_reference" });
            this.logger.warn("pending_reference_retry_failed", {
              transactionId: row.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        await new Promise((r) => setTimeout(r, due.length ? 200 : 1000));
      } catch (err) {
        this.logger.error("pending_reference_worker_error", {
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
