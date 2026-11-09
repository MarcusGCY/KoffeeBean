import { NextResponse } from "next/server";
import { verify } from "@/lib/approval";
import * as gh from "@/lib/github";
// Temporary: fixIssue stays off so Approve does not start the Cursor cloud agent.
// import { after } from "next/server";
// import { fixIssue } from "@/lib/fix";
import { caseFields, recordQualityEvent } from "@/lib/quality-audit";
import { buildEvent, parseCase } from "@/lib/quality-case";

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
  const quality = parseCase(current.body, issue);
  await recordQualityEvent(issue, buildEvent({
    actionId: `approval:${issue}`,
    ...caseFields(quality),
    stage: "approval",
    status: "recorded",
    at: new Date().toISOString(),
    actor: "signed-link",
    issue,
    pr: null,
    agentId: null,
    runId: null,
    evidence: "signed approve link; one app launcher",
    attempt: 1,
    nextOwner: "app",
    blocker: null,
    externalAck: "acknowledged",
  }));
  // Temporary: do not launch the Cursor fix agent. Restore the after(fixIssue) block to turn it back on.
  // after(async () => {
  //   try {
  //     await fixIssue(issue);
  //   } catch (e) {
  //     console.error("[review] fix failed", e instanceof Error ? e.name : "Error");
  //   }
  // });
  return NextResponse.json({ status: "approved-fix-started" });
}
