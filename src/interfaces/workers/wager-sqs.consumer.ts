import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ProcessWagerUseCase } from "../../application/use-cases/process-wager.use-case";
import { SqsService } from "../../infrastructure/messaging/sqs.client";
import { AppLogger } from "../../infrastructure/observability/logger.service";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { IdempotencyConflictError } from "../../domain/shared/domain-error";

const CONSUMER_NAME = "wager-transactions-consumer";
const MAX_RECEIVE_COUNT = 5;

@Injectable()
export class WagerSqsConsumer implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loop?: Promise<void>;
  private inFlight = 0;
  private shuttingDown = false;

  constructor(
    private readonly sqs: SqsService,
    private readonly processWager: ProcessWagerUseCase,
    private readonly logger: AppLogger,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_WORKERS === "true") return;
    this.running = true;
    this.loop = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.running = false;

    const deadline = Date.now() + 25_000;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.loop;
  }

  private async poll(): Promise<void> {
    const queueUrl = process.env.SQS_WAGER_QUEUE_URL;
    const dlqUrl = process.env.SQS_WAGER_DLQ_URL;
    if (!queueUrl) {
      this.logger.warn("sqs_consumer_disabled", { reason: "missing_queue_url" });
      return;
    }

    while (this.running) {
      try {
        if (this.shuttingDown) break;
        const messages = await this.sqs.receive(queueUrl, 5);
        for (const msg of messages) {
          if (this.shuttingDown) {
            await this.sqs.nack(queueUrl, msg.receiptHandle, 0);
            continue;
          }
          this.inFlight += 1;
          try {
            await this.handle(msg, queueUrl, dlqUrl);
          } finally {
            this.inFlight -= 1;
          }
        }
      } catch (err) {
        this.metrics.retries.inc({ component: "sqs_poll" });
        this.logger.error("sqs_poll_error", {
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async handle(
    msg: {
      messageId: string;
      receiptHandle: string;
      body: string;
      receiveCount: number;
    },
    queueUrl: string,
    dlqUrl?: string,
  ): Promise<void> {
    let parsed: {
      messageId?: string;
      type?: string;
      data?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(msg.body) as typeof parsed;
    } catch {
      this.logger.error("sqs_invalid_json", { messageId: msg.messageId });
      await this.toDlq(queueUrl, dlqUrl, msg);
      return;
    }

    const data = parsed.data ?? {};
    const businessMessageId = parsed.messageId ?? msg.messageId;

    try {
      await this.processWager.execute({
        providerId: String(data.providerId),
        externalTransactionId: String(data.externalTransactionId),
        idempotencyKey: String(
          data.idempotencyKey ??
            `${data.providerId}:${data.externalTransactionId}`,
        ),
        playerId: String(data.playerId),
        walletId: String(data.walletId),
        roundId: String(data.roundId),
        gameId: String(data.gameId),
        kind: String(data.kind),
        money: data.money as { amount: string; currency: string },
        referenceExternalTransactionId: data.referenceExternalTransactionId
          ? String(data.referenceExternalTransactionId)
          : undefined,
        inbox: {
          messageId: businessMessageId,
          consumerName: CONSUMER_NAME,
        },
        correlationId: businessMessageId,
      });

      await this.sqs.ack(queueUrl, msg.receiptHandle);
      this.logger.log("sqs_message_processed", {
        messageId: businessMessageId,
        walletId: String(data.walletId),
        providerId: String(data.providerId),
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {

        await this.sqs.ack(queueUrl, msg.receiptHandle);
        return;
      }

      const isTransient = isTransientError(err);
      if (!isTransient || msg.receiveCount >= MAX_RECEIVE_COUNT) {
        this.logger.error("sqs_permanent_or_exhausted", {
          messageId: businessMessageId,
          receiveCount: msg.receiveCount,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.toDlq(queueUrl, dlqUrl, msg);
        return;
      }

      this.metrics.retries.inc({ component: "sqs_handler" });
      const backoff = Math.min(60, 2 ** msg.receiveCount);
      await this.sqs.nack(queueUrl, msg.receiptHandle, backoff);
    }
  }

  private async toDlq(
    queueUrl: string,
    dlqUrl: string | undefined,
    msg: { receiptHandle: string; body: string; messageId: string },
  ): Promise<void> {
    this.metrics.dlq.inc();
    if (dlqUrl) {
      await this.sqs.publish(dlqUrl, JSON.parse(msg.body), {
        messageGroupId: "dlq",
        deduplicationId: msg.messageId,
      });
    }
    await this.sqs.ack(queueUrl, msg.receiptHandle);
  }
}

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ETIMEDOUT|serialization|deadlock|timeout|temporarily/i.test(
    msg,
  );
}
