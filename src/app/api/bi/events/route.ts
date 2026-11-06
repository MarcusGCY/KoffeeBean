import {
  BiQueryError,
  biJson,
  listBiEvents,
  parseEventsQuery,
  requireBiSecret,
  requireBiSql,
} from "@/lib/bi-read";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireBiSecret(req);
  if (denied) return denied;
  const sql = requireBiSql();
  if (sql instanceof Response) return sql;
  try {
    const query = parseEventsQuery(new URL(req.url).searchParams);
    return biJson(await listBiEvents(sql, query));
  } catch (error) {
    if (error instanceof BiQueryError) return biJson({ error: error.message }, 400);
    console.error("[bi] events read failed", error instanceof Error ? error.name : "unknown");
    return biJson({ error: "unavailable" }, 503);
  }
}
