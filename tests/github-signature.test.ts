import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGithubSignature } from "@/lib/github-signature";

const secret = "webhook-secret";
const body = JSON.stringify({ action: "opened" });

function sign(payload: string, key = secret): string {
  return `sha256=${createHmac("sha256", key).update(payload).digest("hex")}`;
}

describe("verifyGithubSignature", () => {
  it("accepts a GitHub sha256 signature", () => {
    expect(verifyGithubSignature(body, sign(body), secret)).toBe(true);
  });

  it("rejects a missing, wrong, or differently signed header", () => {
    expect(verifyGithubSignature(body, null, secret)).toBe(false);
    expect(verifyGithubSignature(body, sign(body, "other"), secret)).toBe(false);
    expect(verifyGithubSignature(body, sign(`${body} `), secret)).toBe(false);
    expect(verifyGithubSignature(body, "sha256=abc", secret)).toBe(false);
  });
});
