import { biJson, requireBiSecret } from "@/lib/bi-read";
import { describeLaunch, launchConfigSchema, launchIssues, launchWriteResult } from "@/lib/demo/launch";
import { listLaunches, readLaunch, saveLaunch } from "@/lib/demo/launch-store";
import { StoreUnavailableError } from "@/lib/store-error";

function invalidSku(sku: string): boolean {
  return !/^[A-Za-z0-9_-]+$/.test(sku) || sku === "index" || sku.length > 64;
}

export async function POST(req: Request) {
  const denied = requireBiSecret(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return biJson({ error: "invalid_json" }, 400);
  }

  const parsed = launchConfigSchema.safeParse(body);
  if (!parsed.success) return biJson({ error: "invalid_body", issues: launchIssues(parsed.error) }, 400);

  try {
    await saveLaunch(parsed.data);
    return biJson(launchWriteResult(parsed.data));
  } catch (error) {
    if (error instanceof StoreUnavailableError) return biJson({ error: "store_unavailable" }, 503);
    console.error("[demo:pelita] launch save failed", error instanceof Error ? error.name : "unknown");
    return biJson({ error: "launch_failed" }, 500);
  }
}

export async function GET(req: Request) {
  const denied = requireBiSecret(req);
  if (denied) return denied;

  const sku = new URL(req.url).searchParams.get("sku")?.trim() ?? "";
  if (sku && invalidSku(sku)) return biJson({ error: "invalid_sku" }, 400);

  try {
    if (sku) {
      const config = await readLaunch(sku);
      if (!config) return biJson({ error: "not_found" }, 404);
      return biJson({ ok: true, ...describeLaunch(config) });
    }
    const launches = await listLaunches();
    return biJson({ ok: true, launches: launches.map((config) => describeLaunch(config)) });
  } catch (error) {
    if (error instanceof StoreUnavailableError) return biJson({ error: "store_unavailable" }, 503);
    console.error("[demo:pelita] launch read failed", error instanceof Error ? error.name : "unknown");
    return biJson({ error: "launch_failed" }, 500);
  }
}
