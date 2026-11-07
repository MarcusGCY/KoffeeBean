import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { productImageUrl } from "@/lib/images";

function publicFile(urlPath: string): string {
  return path.join(process.cwd(), "public", urlPath.replace(/^\/+/, ""));
}

describe("House Espresso image", () => {
  it("points the mug at a file that exists under public/", () => {
    const url = productImageUrl("mug");
    expect(existsSync(publicFile(url)), url).toBe(true);
  });

  it("points House Espresso at a file that exists under public/", () => {
    const url = productImageUrl("espresso-1kg");
    expect(existsSync(publicFile(url)), `espresso-1kg -> ${url}`).toBe(true);
  });
});
