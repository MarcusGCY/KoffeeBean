import { NextResponse } from "next/server";
import { githubHttpStatus } from "@/lib/github";
import { readAdmin } from "@/lib/demo-session";
import { loadQualityAudit } from "@/lib/quality-audit";

export const maxDuration = 60;

/** Admin read of one issue's quality trail. 404 for everyone else. */
export async function GET(req: Request) {
  const admin = await readAdmin();
  if (!admin) return json({ error: "Not found" }, 404);
  const issue = Number(new URL(req.url).searchParams.get("issue"));
  if (!Number.isInteger(issue) || issue <= 0) return json({ error: "issue required" }, 400);
  try {
    return json(await loadQualityAudit(issue));
  } catch (error) {
    if (githubHttpStatus(error) === 404 || (error instanceof Error && "status" in error && error.status === 404)) {
      return json({ error: "Not found" }, 404);
    }
    console.error("[quality] audit read failed", error instanceof Error ? error.name : "Error");
    return json({ error: "unavailable" }, 503);
  }
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}
