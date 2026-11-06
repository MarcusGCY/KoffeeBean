import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import products from "@/data/products.json";
import { productImageUrl } from "@/lib/images";

function publicFile(urlPath: string): string {
  return path.join(process.cwd(), "public", urlPath.replace(/^\/+/, ""));
}

describe("every catalog product image", () => {
  it("has a catalog to check", () => {
    expect(products.length).toBeGreaterThan(0);
  });

  it.each(products.map((p) => [p.id, p.name] as const))(
    "%s (%s) resolves to a file under public/",
    (id) => {
      const url = productImageUrl(id);
      expect(existsSync(publicFile(url)), `${id} -> ${url}`).toBe(true);
    },
  );
});
