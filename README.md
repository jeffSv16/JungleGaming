# JungleGaming — Distributed Wagering Processor

Serviço financeiro distribuído que processa apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`) com correção monetária, idempotência persistente, ledger imutável e concorrência entre múltiplas instâncias.

Stack: **Bun · NestJS · TypeScript strict · PostgreSQL · MikroORM · AWS SQS (LocalStack)**.

Decisões e trade-offs: ver [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Pré-requisitos

- Bun 1.x
- Docker / Docker Compose (PostgreSQL + LocalStack)
- (opcional) PostgreSQL 16 local se não usar Compose para o banco

## Subir infraestrutura

```bash
docker compose up -d postgres localstack --wait
bun run setup:local   # garante filas SQS no LocalStack
```

Variáveis: copie `.env.example` → `.env`.

## Rodar a API

```bash
bun install
bun run start:dev
# escuta em http://127.0.0.1:3847
```

Health:

- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`

## Fluxo rápido (HTTP)

```bash
# 1) Abrir wallet
curl -s localhost:3847/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'

# 2) Apostar (Idempotency-Key obrigatório)
curl -s localhost:3847/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<WALLET_ID>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'

# 3) Reconciliação saldo × ledger
curl -s -X POST localhost:3847/wallets/<WALLET_ID>/reconciliation
```

Entrada equivalente via SQS: fila `wager-transactions.fifo` (mesmo use case da HTTP). Eventos de integração saem pela outbox → `wager-events.fifo`.

## Testes

```bash
bun test test/unit
bun test test/integration --timeout 120000   # Postgres + LocalStack reais
bun test test/concurrency --timeout 180000  # races reais (cenário §8, 50× replay, outbox)
```

Invariante checada: `wallet.balance == saldo reconstruído pelo ledger`.

## Migrations

Versionadas e reversíveis em `src/infrastructure/persistence/migrations/`.

```bash
bun run migration:up
bun run migration:down
```

Rodam automaticamente no boot da aplicação.

## Auth

Não pontua neste desafio. Implementação atual: `NoopAuthGuard` + `ProviderIdentityPort` (ponto de extensão OIDC). Detalhes em `ARCHITECTURE.md`.

## Docker (app + deps)

```bash
docker compose up --build
```
