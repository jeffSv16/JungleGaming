/**
 * Standalone process worker for multi-instance concurrency tests.
 * Usage:
 *   bun run scripts/instance-worker.ts <walletId> <playerId> <externalId> <amount>
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { ProcessWagerUseCase } from "../src/application/use-cases/process-wager.use-case";

async function main(): Promise<void> {
  process.env.DISABLE_WORKERS = "true";
  const [walletId, playerId, externalId, amount] = process.argv.slice(2);
  if (!walletId || !playerId || !externalId || !amount) {
    console.error("usage: instance-worker <walletId> <playerId> <externalId> <amount>");
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  // Migrations already applied by the parent test harness — avoid migrate locks.
  const processWager = app.get(ProcessWagerUseCase);

  const result = await processWager.execute({
    providerId: "provider-a",
    externalTransactionId: externalId,
    idempotencyKey: `provider-a:${externalId}`,
    playerId,
    walletId,
    roundId: `round-${externalId}`,
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount, currency: "BRL" },
  });

  console.log(JSON.stringify(result));
  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
