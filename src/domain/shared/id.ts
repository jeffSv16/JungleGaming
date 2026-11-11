import { randomUUID } from "node:crypto";

/** UUID v4 identifiers (sufficient for challenge; v7 optional). */
export function newId(): string {
  return randomUUID();
}
