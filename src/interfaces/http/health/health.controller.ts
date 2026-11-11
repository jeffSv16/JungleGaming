import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import {
  SQSClient,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { MetricsService } from "../../../infrastructure/observability/metrics.service";

@Controller()
export class HealthController {
  private readonly sqs: SQSClient;

  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
  ) {
    this.sqs = new SQSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.AWS_ENDPOINT_URL,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });
  }

  /** Process alive — no auth. */
  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  /** PostgreSQL + SQS reachable — no auth. */
  @Get("health/ready")
  async ready() {
    const checks: Record<string, string> = {};
    try {
      await this.em.fork().getConnection().execute("SELECT 1");
      checks.postgres = "up";
    } catch {
      checks.postgres = "down";
    }

    try {
      const queueUrl = process.env.SQS_WAGER_QUEUE_URL;
      if (!queueUrl) {
        checks.sqs = "unconfigured";
      } else {
        await this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: ["ApproximateNumberOfMessages"],
          }),
        );
        checks.sqs = "up";
      }
    } catch {
      checks.sqs = "down";
    }

    const ready = checks.postgres === "up" && checks.sqs === "up";
    if (!ready) {
      throw new ServiceUnavailableException({ status: "not_ready", checks });
    }
    return { status: "ready", checks };
  }

  @Get("metrics")
  async prometheusMetrics(): Promise<string> {
    return this.metrics.metricsText();
  }
}
