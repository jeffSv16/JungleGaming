import {
  describe,
  expect,
  test,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/core";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { createTestApp, resetDatabase } from "../helpers/app";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerUseCase } from "../../src/application/use-cases/process-wager.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { OutboxPublisher } from "../../src/interfaces/workers/outbox.publisher";
import { OutboxMessageEntity } from "../../src/infrastructure/persistence/entities/outbox-message.entity";
import { InboxMessageEntity } from "../../src/infrastructure/persistence/entities/inbox-message.entity";
import { WalletLedgerEntryEntity } from "../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { WagerTransactionStatus } from "../../src/domain/wager-transaction/wager-transaction";
import { FailureCode } from "../../src/domain/shared/failure-code";

const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://127.0.0.1:4566";
const region = process.env.AWS_REGION ?? "us-east-1";

function sqsClient() {
  return new SQSClient({
    region,
    endpoint,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

describe("integration: messaging failures + recovery", () => {
  let app: INestApplication;
  let orm: MikroORM;
  let createWallet: CreateWalletUseCase;
  let processWager: ProcessWagerUseCase;
  let reconcile: ReconcileWalletUseCase;
  let outbox: OutboxPublisher;

  beforeAll(async () => {
    ({ app, orm } = await createTestApp());
    createWallet = app.get(CreateWalletUseCase);
    processWager = app.get(ProcessWagerUseCase);
    reconcile = app.get(ReconcileWalletUseCase);
    outbox = app.get(OutboxPublisher);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  test("migrations applied: unique + non-negative constraints exist", async () => {
    const rows = await orm.em.getConnection().execute(`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'uq_wallets_player_currency',
        'chk_wallets_balance_non_negative',
        'uq_wager_idempotency_key',
        'uq_ledger_transaction',
        'chk_ledger_balanced',
        'uq_inbox_consumer_message',
        'uq_reversal_once_per_kind'
      )
      ORDER BY conname
    `);
    expect(rows.length).toBe(7);
  });

  test("crash after commit before ack: redelivery does not double-debit", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const payload = {
      providerId: "provider-a",
      externalTransactionId: "tx-crash-ack",
      idempotencyKey: "provider-a:tx-crash-ack",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "30.00", currency: "BRL" },
      inbox: {
        messageId: "msg-crash-1",
        consumerName: "wager-transactions-consumer",
      },
    };

    // Commit succeeded (simulates process dying before SQS DeleteMessage)
    const first = await processWager.execute(payload);
    expect(first.status).toBe(WagerTransactionStatus.Processed);

    // Redelivery of same SQS messageId + same business payload
    const second = await processWager.execute(payload);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);

    const debits = await orm.em.fork().count(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: "DEBIT",
    });
    expect(debits).toBe(1);

    const inbox = await orm.em.fork().find(InboxMessageEntity, {
      messageId: "msg-crash-1",
    });
    expect(inbox).toHaveLength(1);

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("70.00");
  });

  test("service restart preserves consistency (re-open Nest + reconcile)", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "200.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-restart-1",
      idempotencyKey: "provider-a:tx-restart-1",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "50.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-restart-2",
      idempotencyKey: "provider-a:tx-restart-2",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "WIN",
      money: { amount: "80.00", currency: "BRL" },
      referenceExternalTransactionId: "tx-restart-1",
    });

    // "Restart": close app context and boot a fresh one against same DB
    await app.close();
    ({ app, orm } = await createTestApp());
    createWallet = app.get(CreateWalletUseCase);
    processWager = app.get(ProcessWagerUseCase);
    reconcile = app.get(ReconcileWalletUseCase);
    outbox = app.get(OutboxPublisher);

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("230.00");
  });

  test("outbox survives crash before publish — another publisher drains it", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "50.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-outbox-crash",
      idempotencyKey: "provider-a:tx-outbox-crash",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "5.00", currency: "BRL" },
    });

    const pendingBefore = await orm.em.fork().count(OutboxMessageEntity, {
      publishedAt: null,
    });
    expect(pendingBefore).toBeGreaterThan(0);

    const url =
      process.env.SQS_EVENTS_QUEUE_URL ??
      "http://127.0.0.1:4566/000000000000/wager-events.fifo";
    // Simulate another instance taking over
    await outbox.publishBatch(url, 100);

    const pendingAfter = await orm.em.fork().count(OutboxMessageEntity, {
      publishedAt: null,
    });
    expect(pendingAfter).toBe(0);
  });

  test("double REFUND of same BET → second ALREADY_REVERSED", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-bet-rev",
      idempotencyKey: "provider-a:tx-bet-rev",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "20.00", currency: "BRL" },
    });
    const r1 = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-refund-1",
      idempotencyKey: "provider-a:tx-refund-1",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "REFUND",
      money: { amount: "20.00", currency: "BRL" },
      referenceExternalTransactionId: "tx-bet-rev",
    });
    expect(r1.status).toBe(WagerTransactionStatus.Processed);

    const r2 = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-refund-2",
      idempotencyKey: "provider-a:tx-refund-2",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "REFUND",
      money: { amount: "20.00", currency: "BRL" },
      referenceExternalTransactionId: "tx-bet-rev",
    });
    expect(r2.status).toBe(WagerTransactionStatus.Rejected);
    expect(r2.failureCode).toBe(FailureCode.AlreadyReversed);

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("100.00");
  });

  test("ROLLBACK of WIN before WIN arrives → PENDING_REFERENCE then PROCESSED", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-bet-oo",
      idempotencyKey: "provider-a:tx-bet-oo",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    });

    const rb = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-rb-oo",
      idempotencyKey: "provider-a:tx-rb-oo",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "ROLLBACK",
      money: { amount: "50.00", currency: "BRL" },
      referenceExternalTransactionId: "tx-win-oo",
    });
    expect(rb.status).toBe(WagerTransactionStatus.PendingReference);

    const win = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "tx-win-oo",
      idempotencyKey: "provider-a:tx-win-oo",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "WIN",
      money: { amount: "50.00", currency: "BRL" },
      referenceExternalTransactionId: "tx-bet-oo",
    });
    expect(win.status).toBe(WagerTransactionStatus.Processed);

    const after = await processWager.reprocess(rb.transactionId);
    expect(after.status).toBe(WagerTransactionStatus.Processed);
    // 100 - 10 + 50 - 50 = 90
    expect(after.balance?.amount).toBe("90.00");
    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
  });

  test("SQS retry exhaustion moves message to DLQ", async () => {
    const client = sqsClient();
    const suffix = randomUUID().slice(0, 8);
    const dlqName = `test-dlq-${suffix}.fifo`;
    const mainName = `test-main-${suffix}.fifo`;

    const dlq = await client.send(
      new CreateQueueCommand({
        QueueName: dlqName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
        },
      }),
    );
    const dlqUrl = dlq.QueueUrl!;
    const dlqArn = `arn:aws:sqs:${region}:000000000000:${dlqName}`;

    const main = await client.send(
      new CreateQueueCommand({
        QueueName: mainName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: "3",
          }),
          VisibilityTimeout: "1",
        },
      }),
    );
    const mainUrl = main.QueueUrl!;

    await client.send(
      new SendMessageCommand({
        QueueUrl: mainUrl,
        MessageBody: JSON.stringify({ poison: true }),
        MessageGroupId: "g1",
        MessageDeduplicationId: randomUUID(),
      }),
    );

    // Exhaust receives without deleting → LocalStack redrive to DLQ
    for (let i = 0; i < 5; i++) {
      const res = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: mainUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 1,
        }),
      );
      // intentionally do not delete — visibility expires / receive count climbs
      if (res.Messages?.[0]?.ReceiptHandle) {
        // change nothing; wait for visibility timeout
        await new Promise((r) => setTimeout(r, 1100));
      }
    }

    // Poll DLQ
    let dlqCount = 0;
    for (let i = 0; i < 10; i++) {
      const attrs = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: dlqUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
      );
      dlqCount = Number(
        attrs.Attributes?.ApproximateNumberOfMessages ?? "0",
      );
      if (dlqCount > 0) break;
      const got = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
        }),
      );
      if (got.Messages?.length) {
        dlqCount = got.Messages.length;
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: dlqUrl,
            ReceiptHandle: got.Messages[0]!.ReceiptHandle!,
          }),
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(dlqCount).toBeGreaterThan(0);
  });
});
