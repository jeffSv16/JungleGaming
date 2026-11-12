import Decimal from "decimal.js";

export function formatNumeric(value: string | number): string {
  const raw = typeof value === "number" ? value.toFixed(2) : String(value);
  return new Decimal(raw).toFixed(2);
}
