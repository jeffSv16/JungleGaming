import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";
import { IdempotencyConflictError } from "../../domain/shared/domain-error";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    if (exception instanceof IdempotencyConflictError) {
      res.status(HttpStatus.CONFLICT).json({
        code: "IDEMPOTENCY_CONFLICT",
        message: exception.message,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(
        typeof body === "string" ? { message: body } : body,
      );
      return;
    }

    const message =
      exception instanceof Error ? exception.message : "Internal error";
    const transient =
      /ECONNREFUSED|ETIMEDOUT|timeout|serialization|deadlock|temporarily/i.test(
        message,
      );
    res.status(
      transient
        ? HttpStatus.SERVICE_UNAVAILABLE
        : HttpStatus.INTERNAL_SERVER_ERROR,
    ).json({
      code: transient ? "TRANSIENT_INFRASTRUCTURE" : "INTERNAL_ERROR",
      message: transient ? "Temporary infrastructure failure" : "Internal error",
    });
  }
}
