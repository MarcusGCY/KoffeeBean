import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { productImageUrl } from "@/lib/images";

/** House Espresso 1kg — catalog id used by the storefront image. */
const HOUSE_ESPRESSO_ID = "espresso-1kg";

function publicFile(urlPath: string): string {
  return path.join(process.cwd(), "public", urlPath.replace(/^\/+/, ""));
}

describe("house espresso image", () => {
  it("points House Espresso at an image file that exists under public/", () => {
    const url = productImageUrl(HOUSE_ESPRESSO_ID);
    expect(url).toBe("/images/beans/espresso-1kg.svg");
    expect(existsSync(publicFile(url)), `${HOUSE_ESPRESSO_ID} -> ${url}`).toBe(true);
  });
});
