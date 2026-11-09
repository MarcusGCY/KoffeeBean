import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { productImageUrl } from "@/lib/images";

function publicFile(urlPath: string): string {
  return path.join(process.cwd(), "public", urlPath.replace(/^\/+/, ""));
}

describe("BeanBox Ceramic Mug image", () => {
  it("resolves the mug catalog id to an image under public/", () => {
    const url = productImageUrl("mug");
    expect(url).toBe("/images/merch/mug.svg");
    expect(existsSync(publicFile(url)), url).toBe(true);
  });

  it("shows the mug product image on the store catalog", () => {
    const store = readFileSync("src/components/Store.tsx", "utf8");
    expect(store).toMatch(/src=\{productImageUrl\(p\.id\)\}/);
    expect(store).not.toMatch(/p\.id === "mug" \? "" : productImageUrl/);
  });
});
