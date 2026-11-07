import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { productImageUrl } from "@/lib/images";

function publicFile(urlPath: string): string {
  return path.join(process.cwd(), "public", urlPath.replace(/^\/+/, ""));
}

describe("Colombia Huila product image", () => {
  it("resolves mug merch to a file under public/", () => {
    const url = productImageUrl("mug");
    expect(existsSync(publicFile(url)), url).toBe(true);
  });

  it("resolves colombia-250 to a file under public/", () => {
    const url = productImageUrl("colombia-250");
    expect(url).toBe("/images/beans/colombia-250.svg");
    expect(existsSync(publicFile(url)), url).toBe(true);
  });
});
