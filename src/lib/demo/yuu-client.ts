import type { YuuPanel, YuuPurchaseResult } from "@/lib/yuu/types";

/** Same-origin calls for yuu (simulated). A cross-site request is refused. */

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function buyWithYuuRequest(body: { sku: string; qty?: number; memberId?: string }): Promise<YuuPurchaseResult> {
  const res = await post("/api/demo/pelita/yuu/purchase", body);
  const data = (await res.json().catch(() => null)) as YuuPurchaseResult | { error?: string } | null;
  if (!res.ok || !data || !("pointsEarned" in data)) {
    throw new Error(res.status === 503 ? "yuu (simulated) is not connected." : "Could not record the yuu purchase.");
  }
  return data;
}

export async function simulateYuuBurstRequest(): Promise<YuuPanel> {
  const res = await post("/api/demo/pelita/yuu/simulate");
  const data = (await res.json().catch(() => null)) as (YuuPanel & { isDemo?: boolean }) | null;
  if (!res.ok || !data || !Array.isArray(data.signals) || !Array.isArray(data.members)) {
    throw new Error(res.status === 503 ? "yuu (simulated) is not connected." : "Could not simulate the yuu burst.");
  }
  return data;
}
