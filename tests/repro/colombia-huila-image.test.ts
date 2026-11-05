import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import products from "@/data/products.json";
import { productImageUrl } from "@/lib/images";

function publicFile(urlPath: string): string {
  return path.join(process.cwd(), "public", urlPath.replace(/^\/+/, ""));
}

describe("Colombia Huila catalog image", () => {
  it("still serves merch images from paths under public/", () => {
    const mug = products.find((item) => item.id === "mug");
    expect(mug?.category).toBe("merch");

    const url = productImageUrl(mug!.id);
    expect(url).toBe("/images/merch/mug.svg");
    expect(existsSync(publicFile(url)), url).toBe(true);
  });

  it("loads Colombia Huila from a bean file under public/", () => {
    const product = products.find((item) => item.id === "colombia-250");
    expect(product?.name).toBe("Colombia Huila 250g");

    const url = productImageUrl(product!.id);
    expect(url, "catalog image for Colombia Huila").toBe("/images/beans/colombia-250.svg");
    expect(existsSync(publicFile(url)), `${product!.name} image ${url}`).toBe(true);
  });
});
