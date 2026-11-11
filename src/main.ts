import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import { AppModule } from "./app.module";
import { AppLogger } from "./infrastructure/observability/logger.service";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(AppLogger);
  app.useLogger(logger);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const orm = app.get(MikroORM);
  const migrator = orm.getMigrator();
  await migrator.up();

  const port = Number(process.env.PORT ?? 3847);
  await app.listen(port, "0.0.0.0");
  logger.log("application_started", {
    port,
    instanceId: process.env.INSTANCE_ID ?? "default",
  });

  const shutdown = async (signal: string) => {
    logger.log("shutdown_signal", { signal });
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void bootstrap();
