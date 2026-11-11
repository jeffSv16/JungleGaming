import Decimal from "decimal.js";

/** Normalize DB numeric to fixed 2-decimal string without using JS number. */
export function formatNumeric(value: string | number): string {
  const raw = typeof value === "number" ? value.toFixed(2) : String(value);
  return new Decimal(raw).toFixed(2);
}
