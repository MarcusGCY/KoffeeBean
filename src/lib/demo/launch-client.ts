/** Same-origin call for the ops "Go live now" button. The BI secret stays on the server. */

export async function goLiveNowRequest(sku: string): Promise<void> {
  const res = await fetch("/api/demo/pelita/ops/go-live", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku }),
  });
  if (!res.ok) throw new Error(`go live failed (${res.status})`);
}
