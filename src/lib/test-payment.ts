import { randomBytes } from "node:crypto";

/**
 * TEST-ONLY payment mock for the demo. There is no processor, card, or token:
 * an order just records that it was paid in test mode, with an opaque reference.
 */
export type TestPayment = { mode: "test"; ref: string };

export function createTestPayment(): TestPayment {
  return { mode: "test", ref: `test_${randomBytes(6).toString("hex")}` };
}

export function readTestPayment(value: unknown): TestPayment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.mode !== "test" || typeof record.ref !== "string" || !/^test_[0-9a-f]{12}$/.test(record.ref)) return undefined;
  return { mode: "test", ref: record.ref };
}
