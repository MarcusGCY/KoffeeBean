import * as gh from "./github";
import { classifyForIntake, intakeFailureNote, intakeWebhook } from "./intake-gate";
import { notifyIntakeClassification } from "./notify";
import { settleNewReport } from "./repro-track";
import { triageFeedback } from "./triage";

/**
 * Classify, then triage. S4 and a clear duplicate stop here: no issue and no
 * cloud agent. The shopper already received the thanks response. A classify
 * failure still files, and the issue body says the classify step failed.
 */
export async function fileFeedback(feedback: string, reportedBy: string): Promise<void> {
  const open = await gh.listOpenFeedbackIssues();
  const intake = await classifyForIntake(feedback);
  const duplicateOf = intake.classification?.duplicate_of ?? null;
  await notifyIntakeClassification(
    intakeWebhook(intake, reportedBy, duplicateOf != null ? knownCaseUrl(duplicateOf) : undefined),
  );
  if (intake.action === "hold") {
    console.log(
      `[feedback] intake only reason=${intake.reason} severity=${intake.classification.severity ?? "none"}`,
    );
    return;
  }

  const reported = intake.failure ? `${reportedBy}\n\n${intakeFailureNote(intake.failure)}` : reportedBy;
  const decision = await triageFeedback(feedback, open);
  if (decision.action === "merge" && decision.issueNumber) {
    await gh.appendReport(decision.issueNumber, `${feedback}\n\n${reported}`);
    console.log(`[feedback] merged into #${decision.issueNumber}`);
    return;
  }

  await settleNewReport({
    title: decision.title,
    summary: decision.body,
    feedback,
    reportedBy: reported,
    testPath: decision.testPath,
    branch: decision.branch,
  });
}

function knownCaseUrl(number: number): string | undefined {
  const configured = process.env.GITHUB_REPO?.trim();
  if (!configured) return undefined;
  const [owner, name, extra] = configured.split("/");
  if (!owner || !name || extra !== undefined) return undefined;
  return `https://github.com/${owner}/${name}/issues/${number}`;
}
