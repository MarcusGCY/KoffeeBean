import { describe, expect, it } from "vitest";
import {
  PRESENTER_TTL_MS,
  presenterLink,
  signPresenterToken,
  tokenExpiry,
  verifyPresenterToken,
} from "@/lib/demo/presenter";

const SECRET = "test-approval-secret";
const NOW = 1_800_000_000_000;

describe("presenter token", () => {
  it("signs and verifies", () => {
    const token = signPresenterToken(SECRET, NOW);
    expect(token).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(tokenExpiry(token)).toBe(NOW + PRESENTER_TTL_MS);
    expect(verifyPresenterToken(token, SECRET, NOW)).toBe(true);
    expect(verifyPresenterToken(token, SECRET, NOW + PRESENTER_TTL_MS)).toBe(true);
  });

  it("expires", () => {
    const token = signPresenterToken(SECRET, NOW, 60_000);
    expect(verifyPresenterToken(token, SECRET, NOW + 59_999)).toBe(true);
    expect(verifyPresenterToken(token, SECRET, NOW + 60_001)).toBe(false);
  });

  it("rejects tampering with the expiry, the signature or the secret", () => {
    const token = signPresenterToken(SECRET, NOW, 60_000);
    const [exp, sig] = token.split(".");
    expect(verifyPresenterToken(`${Number(exp) + 3_600_000}.${sig}`, SECRET, NOW)).toBe(false);
    const flipped = `${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`;
    expect(verifyPresenterToken(`${exp}.${flipped}`, SECRET, NOW)).toBe(false);
    expect(verifyPresenterToken(`${exp}.${sig.toUpperCase()}`, SECRET, NOW)).toBe(false);
    expect(verifyPresenterToken(token, "another-secret", NOW)).toBe(false);
  });

  it("rejects malformed input and a missing secret", () => {
    const token = signPresenterToken(SECRET, NOW);
    for (const bad of [undefined, null, "", ".", "abc", `${token}.x`, "1.2", `-1.${"a".repeat(64)}`, "x".repeat(500)]) {
      expect(verifyPresenterToken(bad, SECRET, NOW)).toBe(false);
    }
    expect(verifyPresenterToken(token, "", NOW)).toBe(false);
    expect(() => signPresenterToken("", NOW)).toThrow();
  });

  it("builds a link on the enter route without leaking the secret", () => {
    const link = presenterLink("https://preview.example.com/some/path", SECRET, NOW);
    const url = new URL(link);
    expect(url.origin).toBe("https://preview.example.com");
    expect(url.pathname).toBe("/demo/pelita/enter");
    expect(verifyPresenterToken(url.searchParams.get("k"), SECRET, NOW)).toBe(true);
    expect(link).not.toContain(SECRET);
  });
});
