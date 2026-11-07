import { NextResponse } from "next/server";
import { githubHttpStatus } from "@/lib/github";
import { acknowledgeStage } from "@/lib/quality-audit";
import { isAckStage, verifyQualityAck } from "@/lib/quality-case";

export const maxDuration = 60;

/**
 * Signed adoption or verification acknowledgement.
 * Opening this link does not launch an agent and does not merge.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const issue = Number(url.searchParams.get("issue"));
  const stage = url.searchParams.get("stage") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (!Number.isInteger(issue) || issue <= 0 || !isAckStage(stage)) {
    return json({ error: "Invalid or tampered link" }, 403);
  }
  let verdict: ReturnType<typeof verifyQualityAck>;
  try {
    verdict = verifyQualityAck(issue, stage, token);
  } catch (error) {
    console.error("[quality] ack link check failed", error instanceof Error ? error.name : "Error");
    return json({ error: "Acknowledgement links are not configured." }, 503);
  }
  if (verdict === "expired") return json({ error: "This acknowledgement link has expired." }, 403);
  if (verdict !== "ok") return json({ error: "Invalid or tampered link" }, 403);

  try {
    const result = await acknowledgeStage(issue, stage);
    return json({
      status: result.status,
      stage,
      launchesAgent: false,
      merges: false,
      next: result.audit.next,
    });
  } catch (error) {
    if (githubHttpStatus(error) === 404) return json({ error: "Not found" }, 404);
    console.error("[quality] ack failed", error instanceof Error ? error.name : "Error");
    return json({ error: "The acknowledgement could not be recorded." }, 503);
  }
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}
