import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { IsObject, IsString, IsUUID, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CreateWalletUseCase } from "../../../application/use-cases/create-wallet.use-case";
import { ReconcileWalletUseCase } from "../../../application/use-cases/reconcile-wallet.use-case";
import { NoopAuthGuard } from "../../../infrastructure/auth/noop-auth.guard";
import { EntityManager } from "@mikro-orm/postgresql";
import { WalletEntity } from "../../../infrastructure/persistence/entities/wallet.entity";
import { WalletLedgerEntryEntity } from "../../../infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { NotFoundException } from "@nestjs/common";
import { formatNumeric } from "../../../infrastructure/persistence/mappers/numeric";

class MoneyDto {
  @IsString()
  amount!: string;

  @IsString()
  currency!: string;
}

class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

@Controller("wallets")
@UseGuards(NoopAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
    private readonly em: EntityManager,
  ) {}

  @Post()
  async create(@Body() body: CreateWalletDto) {
    return this.createWallet.execute(body);
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    const wallet = await this.em.fork().findOne(WalletEntity, { id: walletId });
    if (!wallet) {
      throw new NotFoundException({
        code: "WALLET_NOT_FOUND",
        message: "Wallet not found",
      });
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: {
        amount: formatNumeric(wallet.balanceAmount),
        currency: wallet.currency,
      },
      version: wallet.version,
    };
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limitRaw?: string,
  ) {
    const limit = Math.min(Number(limitRaw ?? 50) || 50, 100);
    const fork = this.em.fork();
    const wallet = await fork.findOne(WalletEntity, { id: walletId });
    if (!wallet) {
      throw new NotFoundException({
        code: "WALLET_NOT_FOUND",
        message: "Wallet not found",
      });
    }

    const qb = fork
      .createQueryBuilder(WalletLedgerEntryEntity, "l")
      .where({ walletId })
      .orderBy({ createdAt: "ASC", id: "ASC" })
      .limit(limit + 1);

    if (cursor) {
      const decoded = decodeCursor(cursor);
      qb.andWhere(
        "(l.created_at, l.id) > (?, ?)",
        [decoded.createdAt, decoded.id],
      );
    }

    const rows = await qb.getResult();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && page.length
        ? encodeCursor(page[page.length - 1]!)
        : undefined;

    return {
      items: page.map((e) => ({
        id: e.id,
        walletId: e.walletId,
        transactionId: e.transactionId,
        direction: e.direction,
        money: {
          amount: formatNumeric(e.moneyAmount),
          currency: e.moneyCurrency,
        },
        balanceBefore: {
          amount: formatNumeric(e.balanceBeforeAmount),
          currency: e.balanceBeforeCurrency,
        },
        balanceAfter: {
          amount: formatNumeric(e.balanceAfterAmount),
          currency: e.balanceAfterCurrency,
        },
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }

  @Post(":walletId/reconciliation")
  async reconciliation(@Param("walletId") walletId: string) {
    return this.reconcile.execute(walletId);
  }
}

function encodeCursor(e: WalletLedgerEntryEntity): string {
  return Buffer.from(
    JSON.stringify({ createdAt: e.createdAt.toISOString(), id: e.id }),
  ).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    createdAt: string;
    id: string;
  };
}
