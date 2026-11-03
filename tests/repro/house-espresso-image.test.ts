import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import products from "@/data/products.json";
import { productImageUrl } from "@/lib/images";

test("House Espresso image loads from a file under public/", () => {
  const product = products.find((item) => item.id === "espresso-1kg");
  expect(product?.name).toBe("House Espresso 1kg");

  const url = productImageUrl(product!.id);
  const file = path.join(process.cwd(), "public", url.replace(/^\/+/, ""));
  expect(url, "catalog image for House Espresso").toBe("/images/beans/espresso-1kg.svg");
  expect(existsSync(file), `${product!.name} image ${url}`).toBe(true);
});
