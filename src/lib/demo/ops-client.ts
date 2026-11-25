import type { Rejection } from "./ops-console";

/** Browser calls to the presenter-gated demo API. Same-origin, so the presenter cookie travels with them. */

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function rejectProposalRequest(): Promise<Rejection> {
  const res = await post("/api/demo/pelita/proposal", { action: "reject" });
  if (!res.ok) throw new Error(`reject failed (${res.status})`);
  const data = (await res.json()) as { rejection: Rejection };
  return data.rejection;
}

export async function resetDemoRequest(): Promise<void> {
  const res = await post("/api/demo/pelita/reset");
  if (!res.ok) throw new Error(`reset failed (${res.status})`);
}
