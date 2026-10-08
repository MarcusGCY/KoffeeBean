import { after, NextResponse } from "next/server";
import { verify } from "@/lib/approval";
import * as gh from "@/lib/github";
import { fixIssue } from "@/lib/fix";
import { notifyFixStarted } from "@/lib/notify";

// Hobby Fluid compute allows 300s, including work scheduled with after().
// The fix itself can run much longer; fixIssue persists the run and resumes later.
export const maxDuration = 300;

// Reached via signed links sent to the Grok bot (or the /review page).
export async function GET(req: Request) {
  const u = new URL(req.url);
  const issue = Number(u.searchParams.get("issue"));
  const decision = u.searchParams.get("decision") ?? "";
  const token = u.searchParams.get("token") ?? "";

  if (!issue || !["approve", "reject"].includes(decision) || !verify(issue, decision, token)) {
    return NextResponse.json({ error: "Invalid or tampered link" }, { status: 403 });
  }
  const current = await gh.getIssue(issue);
  if (!current.labels.includes(gh.LABEL_AWAITING)) {
    return NextResponse.json({ status: "already-decided" });
  }

  if (decision === "reject") {
    await gh.comment(issue, "Rejected by human reviewer. No fix will be attempted.");
    await gh.setLabels(issue, [gh.FEEDBACK_LABEL, "wontfix"]);
    await gh.closeIssue(issue);
    return NextResponse.json({ status: "rejected" });
  }

  await gh.setLabels(issue, [gh.FEEDBACK_LABEL, gh.LABEL_APPROVED]);
  after(async () => {
    try {
      await notifyFixStarted({ number: current.number, title: current.title, url: current.url });
      await fixIssue(issue);
    } catch (e) {
      console.error("[review] fix failed", e);
    }
  });
  return NextResponse.json({ status: "approved-fix-started" });
}
