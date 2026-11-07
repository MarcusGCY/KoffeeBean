import * as gh from "./github";
import { classifyForIntake, intakeFailureNote, intakeWebhook, type IntakeDecision } from "./intake-gate";
import { notifyIntakeClassification } from "./notify";
import { newQualityCaseId, qualityCase } from "./quality-case";
import { settleNewReport } from "./repro-track";
import { triageFeedback } from "./triage";

/**
 * Classify, then triage. S4 and a duplicate of an open issue stop here: no
 * issue and no cloud agent. A duplicate of an issue closed as completed is a
 * regression and continues into triage. Any other close, or a state read that
 * fails, is filed as a bug. The shopper already received the thanks response.
 * A classify failure still files, and the issue body says the classify step failed.
 */
export async function fileFeedback(feedback: string, reportedBy: string): Promise<void> {
  const open = await gh.listOpenFeedbackIssues();
  const caseId = newQualityCaseId();
  const intake = await resolveDuplicate(await classifyForIntake(feedback));
  const duplicateOf = intake.classification?.duplicate_of ?? null;
  const signal = intakeWebhook(intake, reportedBy, duplicateOf != null ? knownCaseUrl(duplicateOf) : undefined);
  const quality = qualityCase({
    caseId,
    severity: signal.severity,
    reason: signal.reason,
    category: signal.category,
  });
  const intakeDelivery = await notifyIntakeClassification({ ...signal, caseId: quality?.caseId });
  if (intake.action === "hold") {
    console.log(
      `[feedback] intake only case=${quality?.caseId ?? "none"} reason=${signal.reason} severity=${signal.severity ?? "none"} delivery=${intakeDelivery}`,
    );
    return;
  }

  const reported = intake.failure ? `${reportedBy}\n\n${intakeFailureNote(intake.failure)}` : reportedBy;
  const decision = await triageFeedback(feedback, open);
  if (decision.action === "merge" && decision.issueNumber) {
    await gh.appendReport(decision.issueNumber, `${feedback}\n\n${reported}`);
    console.log(`[feedback] merged into #${decision.issueNumber} case=${quality?.caseId ?? "none"}`);
    return;
  }

  await settleNewReport({
    title: decision.title,
    summary: decision.body,
    feedback,
    reportedBy: reported,
    testPath: decision.testPath,
    branch: decision.branch,
    quality,
    triageAgentId: decision.agentId,
    triageRunId: decision.runId,
    intakeDelivery,
  });
}

/**
 * Hold a duplicate only while that GitHub issue is still open.
 * A closed issue is a regression only when GitHub's state_reason is completed.
 * not_planned, duplicate, a missing reason, or a failed read is filed as a bug.
 */
async function resolveDuplicate(decision: IntakeDecision): Promise<IntakeDecision> {
  if (decision.action !== "hold" || decision.reason !== "duplicate") return decision;
  const number = decision.classification.duplicate_of;
  if (number == null) return { action: "file", classification: decision.classification };
  try {
    const issue = await gh.getIssue(number);
    if (issue.state === "open") return decision;
    if (issue.state === "closed" && issue.stateReason === "completed") {
      return { action: "file", reason: "regression", classification: decision.classification };
    }
  } catch (err) {
    console.error("[feedback] duplicate issue state check failed", err instanceof Error ? err.name : "Error");
  }
  return { action: "file", classification: decision.classification };
}

function knownCaseUrl(number: number): string | undefined {
  const configured = process.env.GITHUB_REPO?.trim();
  if (!configured) return undefined;
  const [owner, name, extra] = configured.split("/");
  if (!owner || !name || extra !== undefined) return undefined;
  return `https://github.com/${owner}/${name}/issues/${number}`;
}
