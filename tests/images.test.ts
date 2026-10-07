import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import products from "@/data/products.json";
import { productImageUrl } from "@/lib/images";

function publicFile(urlPath: string): string {
  return path.join(process.cwd(), "public", urlPath.replace(/^\/+/, ""));
}

describe("product images", () => {
  const beans = products.filter((p) => p.category === "beans");
  const merch = products.filter((p) => p.category === "merch");

  it("points merch at files that exist under public/", () => {
    expect(merch.length).toBeGreaterThan(0);
    for (const p of merch) {
      const url = productImageUrl(p.id);
      expect(existsSync(publicFile(url)), url).toBe(true);
    }
  });

  it("productImageUrl for a bean id returns the path that exists under public/", () => {
    expect(beans.length).toBeGreaterThan(0);
    for (const p of beans) {
      const url = productImageUrl(p.id);
      expect(existsSync(publicFile(url)), `${p.id} -> ${url}`).toBe(true);
    }
  });
});
