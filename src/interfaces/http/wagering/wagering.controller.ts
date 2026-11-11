import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ProcessWagerUseCase } from "../../../application/use-cases/process-wager.use-case";
import { NoopAuthGuard } from "../../../infrastructure/auth/noop-auth.guard";
import { EntityManager } from "@mikro-orm/postgresql";
import { WagerTransactionEntity } from "../../../infrastructure/persistence/entities/wager-transaction.entity";
import { NotFoundException } from "@nestjs/common";
import { mapTxEntityToDomain } from "../../../infrastructure/persistence/mappers/wager.mapper";
import { IdempotencyConflictError } from "../../../domain/shared/domain-error";
import { WagerTransactionStatus } from "../../../domain/wager-transaction/wager-transaction";

class MoneyDto {
  @IsString()
  amount!: string;

  @IsString()
  currency!: string;
}

class SubmitWagerDto {
  @IsString()
  providerId!: string;

  @IsString()
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  roundId!: string;

  @IsString()
  gameId!: string;

  @IsString()
  kind!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  referenceExternalTransactionId?: string;
}

@Controller()
@UseGuards(NoopAuthGuard)
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerUseCase,
    private readonly em: EntityManager,
  ) {}

  @Post("wagering/transactions")
  @HttpCode(HttpStatus.OK)
  async submit(
    @Body() body: SubmitWagerDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new HttpException(
        {
          code: "INVALID_PAYLOAD",
          message: "Idempotency-Key header is required",
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const result = await this.processWager.execute({
        ...body,
        idempotencyKey,
        correlationId: idempotencyKey,
      });

      const status = mapHttpStatus(result.status, result.idempotentReplay);
      if (status !== HttpStatus.OK && status !== HttpStatus.CREATED) {
        throw new HttpException(
          {
            transactionId: result.transactionId,
            status: result.status,
            balance: result.balance,
            failureCode: result.failureCode,
            idempotentReplay: result.idempotentReplay,
          },
          status,
        );
      }

      return {
        transactionId: result.transactionId,
        status: result.status,
        balance: result.balance,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      };
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        throw new HttpException(
          {
            code: "IDEMPOTENCY_CONFLICT",
            message: err.message,
          },
          HttpStatus.CONFLICT,
        );
      }
      throw err;
    }
  }

  @Get("wagering/transactions/:transactionId")
  async getById(@Param("transactionId") transactionId: string) {
    const row = await this.em
      .fork()
      .findOne(WagerTransactionEntity, { id: transactionId });
    if (!row) {
      throw new NotFoundException({
        code: "TRANSACTION_NOT_FOUND",
        message: "Transaction not found",
      });
    }
    return serializeTx(mapTxEntityToDomain(row));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternal(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const row = await this.em.fork().findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
    if (!row) {
      throw new NotFoundException({
        code: "TRANSACTION_NOT_FOUND",
        message: "Transaction not found",
      });
    }
    return serializeTx(mapTxEntityToDomain(row));
  }
}

function mapHttpStatus(
  status: WagerTransactionStatus,
  replay: boolean,
): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.OK;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED; // 202 — accepted, processing pending
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY; // 422 — business rule
    case WagerTransactionStatus.Failed:
      return HttpStatus.INTERNAL_SERVER_ERROR;
    default:
      return replay ? HttpStatus.OK : HttpStatus.OK;
  }
}

function serializeTx(
  tx: ReturnType<typeof mapTxEntityToDomain>,
): Record<string, unknown> {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode,
    balance: tx.observedBalance?.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    processedAt: tx.processedAt?.toISOString(),
  };
}
