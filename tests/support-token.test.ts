import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signActionToken, verifyAction } from "@/lib/pending-action";
import { signSupportToken, verifySupportToken } from "@/lib/support-token";

describe("support token", () => {
  const now = 1_700_000_000_000;
  const secret = "shared-secret";

  it("rejects a bad signature or expiry", () => {
    const token = signSupportToken("auth0|shopper", secret, now);
    expect(verifySupportToken(token, secret, now)).toEqual({ userId: "auth0|shopper" });
    expect(verifySupportToken(token, secret, now + 299_000)).toEqual({ userId: "auth0|shopper" });
    expect(verifySupportToken(token, secret, now + 300_000)).toBeNull();
    expect(verifySupportToken(token, "other-secret", now)).toBeNull();
    const [payload, sig] = token.split(".");
    expect(verifySupportToken(`${payload}.${sig?.slice(0, -1)}x`, secret, now)).toBeNull();
    expect(verifySupportToken("not-a-token", secret, now)).toBeNull();
  });

  it("rejects a token signed with the raw secret, a triage marker, and an approval link", () => {
    const claims = {
      typ: "support",
      sub: "auth0|shopper",
      exp: Math.floor(now / 1000) + 300,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const rawSig = createHmac("sha256", secret).update(payload).digest("base64url");
    expect(verifySupportToken(`${payload}.${rawSig}`, secret, now)).toBeNull();

    const markerBody = JSON.stringify({
      testPath: "tests/repro/tote.test.ts",
      branch: "beanbox-triage/tote",
      sha: "a".repeat(40),
    });
    const markerSig = createHmac("sha256", secret).update(markerBody).digest("hex");
    const marker = `<!-- beanbox-repro ${markerBody} ${markerSig} -->`;
    expect(verifySupportToken(marker, secret, now)).toBeNull();

    const approve = createHmac("sha256", secret).update("12:approve").digest("hex");
    expect(verifySupportToken(approve, secret, now)).toBeNull();
    const exp = now + 48 * 60 * 60 * 1000;
    const merge = `${exp}.${createHmac("sha256", secret).update(`merge:12:34:${exp}`).digest("hex")}`;
    expect(verifySupportToken(merge, secret, now)).toBeNull();
  });

  it("does not accept an action id as a support token, or a support token as an action", () => {
    const support = signSupportToken("auth0|shopper", secret, now);
    const actionId = signActionToken(
      {
        typ: "action",
        sub: "auth0|shopper",
        exp: Math.floor(now / 1000) + 300,
        jti: "jti-1",
        summary: "Add 1 mug",
        action: { op: "add_to_cart", productId: "mug", qty: 1 },
      },
      secret,
    );
    expect(verifySupportToken(actionId, secret, now)).toBeNull();
    expect(verifyAction(support, secret, now)).toBeNull();
    expect(verifyAction(actionId, secret, now)?.sub).toBe("auth0|shopper");
    expect(verifySupportToken(support, secret, now)?.userId).toBe("auth0|shopper");
  });
});
