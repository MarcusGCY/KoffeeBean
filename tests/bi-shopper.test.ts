import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const neonMock = vi.hoisted(() => vi.fn());
vi.mock("@neondatabase/serverless", () => ({ neon: neonMock }));

import { hashShopperId } from "@/lib/bi-hash";
import { recommendAddedProductIds } from "@/lib/bi-shopper";

let dbCount = 0;

beforeEach(() => {
  process.env.BI_HASH_SECRET = "test-bi-hash-secret-0123456789";
  dbCount += 1;
  process.env.DATABASE_URL = `postgres://user:pw@shopper${dbCount}.example/neondb`;
  neonMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.BI_HASH_SECRET;
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

describe("recommendAddedProductIds", () => {
  it("reads this shopper's recommend.added product ids by keyed hash, keeping repeats", async () => {
    const sql = vi.fn(async () => [{ product_id: "kenya-ichangi-200" }, { product_id: "kenya-ichangi-200" }, { product_id: null }]);
    neonMock.mockReturnValue(sql);
    expect(await recommendAddedProductIds("auth0|abc")).toEqual(["kenya-ichangi-200", "kenya-ichangi-200"]);
    const call = sql.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(call[0].join("?")).toContain("event_type = 'recommend.added'");
    expect(call[1]).toBe(hashShopperId("auth0|abc"));
    expect(JSON.stringify(call)).not.toContain("auth0|abc");
  });

  it("returns [] when the database is unset, the secret is missing, or the query fails", async () => {
    neonMock.mockReturnValue(vi.fn(async () => {
      throw new Error("boom");
    }));
    expect(await recommendAddedProductIds("auth0|abc")).toEqual([]);
    delete process.env.BI_HASH_SECRET;
    expect(await recommendAddedProductIds("auth0|abc")).toEqual([]);
    process.env.BI_HASH_SECRET = "test-bi-hash-secret-0123456789";
    delete process.env.DATABASE_URL;
    expect(await recommendAddedProductIds("auth0|abc")).toEqual([]);
  });
});
