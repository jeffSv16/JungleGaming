/**
 * Creates SQS queues against LocalStack when not using the init hook.
 */
import {
  CreateQueueCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

const client = new SQSClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint: process.env.AWS_ENDPOINT_URL ?? "http://127.0.0.1:4566",
  credentials: {
    accessKeyId: "test",
    secretAccessKey: "test",
  },
});

async function ensure(name: string, fifo = true): Promise<void> {
  try {
    await client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: fifo ? "true" : "false",
          ContentBasedDeduplication: "false",
        },
      }),
    );
    console.log(`queue ok: ${name}`);
  } catch (err) {
    console.log(`queue ensure: ${name}`, err);
  }
}

await ensure("wager-transactions-dlq.fifo");
await ensure("wager-transactions.fifo");
await ensure("wager-events.fifo");
