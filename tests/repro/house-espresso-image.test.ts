import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { productImageUrl } from "@/lib/images";

function publicFile(urlPath: string): string {
  return path.join(process.cwd(), "public", urlPath.replace(/^\/+/, ""));
}

describe("House Espresso 1kg image", () => {
  it("serves merch images from /images/merch (control)", () => {
    expect(productImageUrl("mug")).toBe("/images/merch/mug.svg");
  });

  it("resolves the House Espresso 1kg image to a file that exists under public/", () => {
    const url = productImageUrl("espresso-1kg");
    expect(url).toBe("/images/beans/espresso-1kg.svg");
    expect(existsSync(publicFile(url))).toBe(true);
  });
});
