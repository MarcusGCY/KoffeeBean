import { describe, expect, it } from "vitest";
import { signSupportToken as signShop, verifySupportToken as verifyShop } from "@/lib/support-token";
import { signSupportToken as signAgent, verifySupportToken as verifyAgent } from "../support-agent/bot/lib/token";

describe("support token", () => {
  const now = 1_700_000_000_000;
  const secret = "shared-secret";

  it("matches between the shop and the agent, and rejects a bad signature or expiry", () => {
    const shop = signShop("auth0|shopper", secret, now);
    const agent = signAgent("auth0|shopper", secret, now);
    expect(shop).toBe(agent);
    expect(verifyShop(agent, secret, now)).toEqual({ userId: "auth0|shopper" });
    expect(verifyAgent(shop, secret, now + 299_000)).toEqual({ userId: "auth0|shopper" });
    expect(verifyShop(shop, secret, now + 300_000)).toBeNull();
    expect(verifyAgent(shop, "other-secret", now)).toBeNull();
    const [payload, sig] = shop.split(".");
    expect(verifyShop(`${payload}.${sig?.slice(0, -1)}x`, secret, now)).toBeNull();
    expect(verifyAgent("not-a-token", secret, now)).toBeNull();
  });
});
