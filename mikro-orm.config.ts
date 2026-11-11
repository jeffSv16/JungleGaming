import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { TsMorphMetadataProvider } from "@mikro-orm/reflection";

export default defineConfig({
  host: process.env.POSTGRES_HOST ?? "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? "wager",
  password: process.env.POSTGRES_PASSWORD ?? "wager",
  dbName: process.env.POSTGRES_DB ?? "wagering",
  entities: ["dist/infrastructure/persistence/entities/*.js"],
  entitiesTs: ["src/infrastructure/persistence/entities/*.ts"],
  migrations: {
    path: "dist/infrastructure/persistence/migrations",
    pathTs: "src/infrastructure/persistence/migrations",
    glob: "!(*.d).{js,ts}",
  },
  metadataProvider: TsMorphMetadataProvider,
  extensions: [Migrator],
  debug: process.env.MIKRO_ORM_DEBUG === "true",
});
