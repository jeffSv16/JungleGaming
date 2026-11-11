import { createHash } from "node:crypto";

/**
 * Canonical JSON: recursively sort object keys, then SHA-256 hex.
 * Transport metadata (Idempotency-Key header, messageId, etc.) must NOT be included.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function computePayloadHash(businessPayload: unknown): string {
  return createHash("sha256").update(canonicalJson(businessPayload)).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

/** Business fields that participate in idempotency payload hashing. */
export function wagerBusinessPayload(input: {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}): unknown {
  return {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money,
    referenceExternalTransactionId:
      input.referenceExternalTransactionId ?? null,
  };
}
