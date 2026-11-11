import {
  describe,
  expect,
  test,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { INestApplication } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/core";
import { createTestApp, resetDatabase } from "../helpers/app";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { WalletLedgerEntryEntity } from "../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { WagerTransactionStatus } from "../../src/domain/wager-transaction/wager-transaction";

function runInstance(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", "scripts/instance-worker.ts", ...args], {
      cwd: "/workspace",
      env: {
        ...process.env,
        DISABLE_WORKERS: "true",
        POSTGRES_HOST: process.env.POSTGRES_HOST ?? "127.0.0.1",
        POSTGRES_PORT: process.env.POSTGRES_PORT ?? "5432",
        POSTGRES_USER: process.env.POSTGRES_USER ?? "wager",
        POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? "wager",
        POSTGRES_DB: process.env.POSTGRES_DB ?? "wagering",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe("concurrency: ≥3 OS processes", () => {
  let app: INestApplication;
  let orm: MikroORM;
  let createWallet: CreateWalletUseCase;
  let reconcile: ReconcileWalletUseCase;

  beforeAll(async () => {
    ({ app, orm } = await createTestApp());
    createWallet = app.get(CreateWalletUseCase);
    reconcile = app.get(ReconcileWalletUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  test("3 simultaneous processes race on same wallet (80+80+80 on 100)", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    // Release parent connections before spawning 3 full Nest processes.
    await app.close();

    const jobs = [1, 2, 3].map((n) =>
      runInstance([
        wallet.id,
        wallet.playerId,
        `multi-inst-${n}-${randomUUID().slice(0, 8)}`,
        "80.00",
      ]),
    );

    const results = await Promise.all(jobs);
    for (const r of results) {
      if (r.code !== 0) {
        throw new Error(
          `worker failed code=${r.code} stderr=${r.stderr}\nstdout=${r.stdout}`,
        );
      }
    }

    const parsed = results.map((r) => {
      const line = r.stdout
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .pop();
      return JSON.parse(line!) as {
        status: WagerTransactionStatus;
        balance?: { amount: string };
      };
    });

    const processed = parsed.filter(
      (p) => p.status === WagerTransactionStatus.Processed,
    );
    const rejected = parsed.filter(
      (p) => p.status === WagerTransactionStatus.Rejected,
    );
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(2);

    // Re-open harness to assert final DB state
    ({ app, orm } = await createTestApp());
    createWallet = app.get(CreateWalletUseCase);
    reconcile = app.get(ReconcileWalletUseCase);

    const debits = await orm.em.fork().count(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: "DEBIT",
    });
    expect(debits).toBe(1);

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("20.00");
  });

  test("3 processes: identical idempotency key → single debit", async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const externalId = `same-key-${randomUUID().slice(0, 8)}`;

    await app.close();

    const results = await Promise.all(
      [1, 2, 3].map(() =>
        runInstance([wallet.id, wallet.playerId, externalId, "15.00"]),
      ),
    );
    for (const r of results) {
      if (r.code !== 0) {
        throw new Error(
          `worker failed code=${r.code} stderr=${r.stderr}\nstdout=${r.stdout}`,
        );
      }
    }

    ({ app, orm } = await createTestApp());
    createWallet = app.get(CreateWalletUseCase);
    reconcile = app.get(ReconcileWalletUseCase);

    const debits = await orm.em.fork().count(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: "DEBIT",
    });
    expect(debits).toBe(1);

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("85.00");
  });
});
