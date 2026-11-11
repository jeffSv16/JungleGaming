import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import { OutboxMessageEntity } from "../../infrastructure/persistence/entities/outbox-message.entity";
import { SqsService } from "../../infrastructure/messaging/sqs.client";
import { AppLogger } from "../../infrastructure/observability/logger.service";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { OutboxMessage } from "../../domain/outbox/outbox-message";

/**
 * Concurrent-safe outbox publisher.
 * Claims due rows with SKIP LOCKED so multiple instances can share work.
 */
@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsService,
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
    const eventsUrl = process.env.SQS_EVENTS_QUEUE_URL;
    if (!eventsUrl) {
      this.logger.warn("outbox_publisher_disabled", {
        reason: "missing_events_queue",
      });
      return;
    }

    while (this.running) {
      try {
        const published = await this.publishBatch(eventsUrl);
        if (published === 0) {
          await this.refreshLag();
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (err) {
        this.metrics.retries.inc({ component: "outbox" });
        this.logger.error("outbox_publisher_error", {
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async publishBatch(eventsUrl: string, limit = 20): Promise<number> {
    const fork = this.em.fork();
    return fork.transactional(async (tem) => {
      const now = new Date();
      const rows = await tem
        .createQueryBuilder(OutboxMessageEntity, "o")
        .where({ publishedAt: null })
        .andWhere("o.next_attempt_at IS NULL OR o.next_attempt_at <= ?", [now])
        .orderBy({ occurredAt: "ASC" })
        .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
        .limit(limit)
        .getResult();

      let count = 0;
      for (const row of rows) {
        const domain = OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregateId,
          eventType: row.eventType,
          payload: row.payload,
          occurredAt: row.occurredAt,
          attempts: row.attempts,
          nextAttemptAt: row.nextAttemptAt,
          publishedAt: row.publishedAt,
        });
        try {
          await this.sqs.publish(eventsUrl, row.payload, {
            messageGroupId: row.aggregateId,
            deduplicationId: row.id,
          });
          domain.markPublished(new Date());
          row.publishedAt = domain.publishedAt;
          row.nextAttemptAt = undefined;
          count += 1;
        } catch (err) {
          domain.scheduleRetry(new Date());
          row.attempts = domain.attempts;
          row.nextAttemptAt = domain.nextAttemptAt;
          this.metrics.retries.inc({ component: "outbox_publish" });
          this.logger.warn("outbox_publish_retry", {
            eventType: row.eventType,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await tem.flush();
      return count;
    });
  }

  private async refreshLag(): Promise<void> {
    const fork = this.em.fork();
    const oldest = await fork.findOne(
      OutboxMessageEntity,
      { publishedAt: null },
      { orderBy: { occurredAt: "ASC" } },
    );
    if (!oldest) {
      this.metrics.outboxLag.set(0);
      return;
    }
    this.metrics.outboxLag.set(
      (Date.now() - oldest.occurredAt.getTime()) / 1000,
    );
  }
}
