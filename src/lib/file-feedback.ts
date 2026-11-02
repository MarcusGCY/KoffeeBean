import * as gh from "./github";
import { settleNewReport } from "./repro-track";
import { triageFeedback } from "./triage";

/**
 * Triage a report. An `awaiting-review` issue is opened only when the
 * reproduction check's test job fails. A passing test, a missing test, or a
 * setup error is closed as `cannot-reproduce`. A check that is still running
 * is stored as `repro-pending` and resumed like an in-flight fix.
 */
export async function fileFeedback(feedback: string, reportedBy: string): Promise<void> {
  const open = await gh.listOpenFeedbackIssues();
  const decision = await triageFeedback(feedback, open);
  if (decision.action === "merge" && decision.issueNumber) {
    await gh.appendReport(decision.issueNumber, `${feedback}\n\n${reportedBy}`);
    console.log(`[feedback] merged into #${decision.issueNumber}`);
    return;
  }

  await settleNewReport({
    title: decision.title,
    summary: decision.body,
    feedback,
    reportedBy,
    testPath: decision.testPath,
    branch: decision.branch,
  });
}
