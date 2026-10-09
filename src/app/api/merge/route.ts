import { NextResponse } from "next/server";
import { verifyMergeToken } from "@/lib/merge-link";
import { MergeError, mergeApprovedFix } from "@/lib/merge";

// Signed GET, same as /api/review. The Grok bot opens the link directly.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const issue = Number(url.searchParams.get("issue"));
  const pr = Number(url.searchParams.get("pr"));
  const token = url.searchParams.get("token") ?? "";

  if (!Number.isInteger(issue) || issue <= 0 || !Number.isInteger(pr) || pr <= 0) {
    return json({ error: "Invalid or tampered link" }, 403);
  }

  let verdict: ReturnType<typeof verifyMergeToken>;
  try {
    verdict = verifyMergeToken(issue, pr, token);
  } catch (error) {
    console.error("[merge] link check failed", error);
    return json({ error: "Merge links are not configured." }, 503);
  }
  if (verdict === "expired") return json({ error: "This merge link has expired." }, 403);
  if (verdict !== "ok") return json({ error: "Invalid or tampered link" }, 403);

  try {
    const result = await mergeApprovedFix(issue, pr);
    return json(result, 200);
  } catch (error) {
    if (error instanceof MergeError) return json({ error: error.message }, error.status);
    console.error("[merge] failed", error);
    return json({ error: "The merge could not be completed." }, 500);
  }
}

function json(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}
