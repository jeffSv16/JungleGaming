import { Injectable, LoggerService as NestLoggerService } from "@nestjs/common";

export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

@Injectable()
export class AppLogger implements NestLoggerService {
  private write(
    level: string,
    message: string,
    fields: LogFields = {},
  ): void {
    const safe = { ...fields };
    delete safe.money;
    delete safe.payload;
    delete safe.initialBalance;
    delete safe.balance;

    console.log(
      JSON.stringify({
        level,
        message,
        time: new Date().toISOString(),
        ...safe,
      }),
    );
  }

  log(message: unknown, ...optional: unknown[]): void {
    this.write("info", String(message), this.normalize(optional));
  }
  error(message: unknown, ...optional: unknown[]): void {
    this.write("error", String(message), this.normalize(optional));
  }
  warn(message: unknown, ...optional: unknown[]): void {
    this.write("warn", String(message), this.normalize(optional));
  }
  debug(message: unknown, ...optional: unknown[]): void {
    this.write("debug", String(message), this.normalize(optional));
  }
  verbose(message: unknown, ...optional: unknown[]): void {
    this.write("verbose", String(message), this.normalize(optional));
  }

  private normalize(optional: unknown[]): LogFields {
    if (optional.length === 0) return {};
    const first = optional[0];
    if (typeof first === "string") {
      return { context: first };
    }
    if (first && typeof first === "object") {
      return first as LogFields;
    }
    return {};
  }
}
