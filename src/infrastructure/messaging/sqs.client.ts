import { Injectable } from "@nestjs/common";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";

@Injectable()
export class SqsService {
  readonly client: SQSClient;

  constructor() {
    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.AWS_ENDPOINT_URL,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });
  }

  async receive(
    queueUrl: string,
    max = 5,
  ): Promise<
    Array<{
      messageId: string;
      receiptHandle: string;
      body: string;
      receiveCount: number;
    }>
  > {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
        AttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    return (res.Messages ?? []).map((m) => ({
      messageId: m.MessageId ?? "",
      receiptHandle: m.ReceiptHandle ?? "",
      body: m.Body ?? "",
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? "1"),
    }));
  }

  async ack(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  async nack(
    queueUrl: string,
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeoutSeconds,
      }),
    );
  }

  async publish(
    queueUrl: string,
    body: unknown,
    opts?: { messageGroupId?: string; deduplicationId?: string },
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(body),
        MessageGroupId: opts?.messageGroupId ?? "default",
        MessageDeduplicationId:
          opts?.deduplicationId ?? `${Date.now()}-${Math.random()}`,
      }),
    );
  }

  async isReachable(queueUrl: string): Promise<boolean> {
    try {
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
}
