import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import { AppModule } from "../../src/app.module";

export async function createTestApp(): Promise<{
  app: INestApplication;
  orm: MikroORM;
}> {
  process.env.DISABLE_WORKERS = "true";
  process.env.POSTGRES_HOST = process.env.POSTGRES_HOST ?? "127.0.0.1";
  process.env.POSTGRES_PORT = process.env.POSTGRES_PORT ?? "5432";
  process.env.POSTGRES_USER = process.env.POSTGRES_USER ?? "wager";
  process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? "wager";
  process.env.POSTGRES_DB = process.env.POSTGRES_DB ?? "wagering";
  process.env.AWS_ENDPOINT_URL =
    process.env.AWS_ENDPOINT_URL ?? "http://127.0.0.1:4566";
  process.env.SQS_WAGER_QUEUE_URL =
    process.env.SQS_WAGER_QUEUE_URL ??
    "http://127.0.0.1:4566/000000000000/wager-transactions.fifo";
  process.env.SQS_WAGER_DLQ_URL =
    process.env.SQS_WAGER_DLQ_URL ??
    "http://127.0.0.1:4566/000000000000/wager-transactions-dlq.fifo";
  process.env.SQS_EVENTS_QUEUE_URL =
    process.env.SQS_EVENTS_QUEUE_URL ??
    "http://127.0.0.1:4566/000000000000/wager-events.fifo";

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.init();
  const orm = app.get(MikroORM);
  await orm.getMigrator().up();
  return { app, orm };
}

export async function resetDatabase(orm: MikroORM): Promise<void> {
  const conn = orm.em.getConnection();
  await conn.execute(`
    TRUNCATE TABLE transaction_reversals, outbox_messages, inbox_messages,
      wallet_ledger_entries, wager_transactions, wallets RESTART IDENTITY CASCADE
  `);
}
