import { beforeEach, describe, expect, it, vi } from "vitest";
import { signSupportToken } from "@/lib/support-token";
import { getCart, getOrder, recordAudit } from "@/lib/store-meta";
import { GET as getCartRoute } from "@/app/api/agent/cart/route";
import { GET as getOrderRoute } from "@/app/api/agent/orders/[id]/route";

vi.mock("@/lib/store-meta", () => ({
  getCart: vi.fn(),
  getOrder: vi.fn(),
  recordAudit: vi.fn(),
}));

describe("agent shop API", () => {
  beforeEach(() => {
    process.env.SUPPORT_AGENT_SECRET = "agent-secret";
    vi.mocked(getCart).mockReset();
    vi.mocked(getOrder).mockReset();
    vi.mocked(recordAudit).mockReset();
    vi.mocked(recordAudit).mockResolvedValue();
  });

  it("uses the token shopper and ignores a userId query", async () => {
    vi.mocked(getCart).mockResolvedValue({
      items: [],
      coupon: "SAVE10",
      subtotalCents: 0,
      discountCents: 0,
      taxCents: 0,
      totalCents: 0,
    });
    const token = signSupportToken("auth0|real", "agent-secret");
    const res = await getCartRoute(
      new Request("http://localhost/api/agent/cart?userId=auth0|evil", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { coupon?: string; discountApplied: boolean };
    expect(body.coupon).toBeUndefined();
    expect(body.discountApplied).toBe(false);
    expect(vi.mocked(getCart)).toHaveBeenCalledWith("auth0|real");
    expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(
      "auth0|real",
      expect.objectContaining({ tool: "view_cart", outcome: "ok" }),
    );
  });

  it("rejects a missing or bad token before reading the store", async () => {
    const missing = await getCartRoute(new Request("http://localhost/api/agent/cart"));
    expect(missing.status).toBe(401);
    const bad = await getOrderRoute(
      new Request("http://localhost/api/agent/orders/BB-1?userId=auth0|evil", {
        headers: { authorization: "Bearer not-a-token" },
      }),
      { params: Promise.resolve({ id: "BB-1" }) },
    );
    expect(bad.status).toBe(401);
    expect(vi.mocked(getCart)).not.toHaveBeenCalled();
    expect(vi.mocked(getOrder)).not.toHaveBeenCalled();
  });
});
