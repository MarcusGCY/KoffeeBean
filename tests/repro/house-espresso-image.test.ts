import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import products from "@/data/products.json";
import { productImageUrl } from "@/lib/images";

function publicFile(urlPath: string): string {
  return path.join(process.cwd(), "public", urlPath.replace(/^\/+/, ""));
}

describe("House Espresso image", () => {
  it("loads the House Espresso catalog photo from a file under public/", () => {
    const product = products.find((item) => item.name.includes("House Espresso"));
    expect(product, "House Espresso is in the catalog").toBeDefined();
    const url = productImageUrl(product!.id);
    expect(existsSync(publicFile(url)), `House Espresso image ${url} does not load`).toBe(true);
  });
});
