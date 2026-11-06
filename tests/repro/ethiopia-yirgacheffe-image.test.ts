import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { productImageUrl } from "@/lib/images";

function publicFile(urlPath: string): string {
  return path.join(process.cwd(), "public", urlPath.replace(/^\/+/, ""));
}

describe("Ethiopia Yirgacheffe catalog image", () => {
  it("resolves merch product image to a file under public/", () => {
    const url = productImageUrl("mug");
    expect(existsSync(publicFile(url)), url).toBe(true);
  });

  it("resolves Ethiopia Yirgacheffe bean image to a file under public/", () => {
    const url = productImageUrl("ethiopia-250");
    expect(existsSync(publicFile(url)), `${url} missing`).toBe(true);
  });
});
