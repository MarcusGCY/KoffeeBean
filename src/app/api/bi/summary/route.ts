import {
  BiQueryError,
  biJson,
  biSummary,
  parseSummaryQuery,
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
    const query = parseSummaryQuery(new URL(req.url).searchParams);
    return biJson(await biSummary(sql, query));
  } catch (error) {
    if (error instanceof BiQueryError) return biJson({ error: error.message }, 400);
    console.error("[bi] summary read failed", error instanceof Error ? error.name : "unknown");
    return biJson({ error: "unavailable" }, 503);
  }
}
