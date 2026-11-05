import { POST as classifyPost } from "@/app/api/triage/classify/route";
import type { OpenIssue } from "@/lib/github";
import { ClassifyOutput, DUPLICATE_CONFIDENCE_MIN, type ClassifyOutput as Classification } from "@/lib/triage-classify";

export type IntakeDecision =
  | { action: "hold"; reason: "s4" | "duplicate"; classification: Classification }
  | { action: "file"; failure?: string };

const NOTE = "Intake classify failed. This report was filed anyway so a real bug is not dropped.";

export function intakeFailureNote(failure: string): string {
  return `**${NOTE}** (${failureCode(failure)})`;
}

/**
 * Open feedback issues are the known bugs available server-side (number, title, body).
 * category and suspected_area are not stored, so applyDuplicate will not keep
 * duplicate_of until they are. Follow-up: persist both and pass them here.
 */
export function candidatesFromOpenIssues(open: OpenIssue[]) {
  return open.slice(0, 30).flatMap((issue) => {
    if (!Number.isInteger(issue.number) || issue.number <= 0) return [];
    const title = issue.title.trim().slice(0, 300);
    if (!title) return [];
    const body = issue.body.trim().slice(0, 4000);
    return [{ number: issue.number, title, ...(body ? { body } : {}) }];
  });
}

/** Map a classify result onto file vs hold. Customer text is not read here. */
export function decideIntake(raw: unknown): IntakeDecision {
  const parsed = ClassifyOutput.safeParse(raw);
  if (!parsed.success) return { action: "file", failure: "error" };
  const classification = parsed.data;
  if (classification.fallback === true) {
    const reason = classification.fallback_reason?.trim() || "fallback";
    const labeled = reason === "fallback" || reason.startsWith("fallback_") ? reason : `fallback_${reason}`;
    return { action: "file", failure: failureCode(labeled) };
  }
  if (classification.needs_human) return { action: "file", failure: "needs_human" };
  if (classification.duplicate_of != null && classification.duplicate_confidence >= DUPLICATE_CONFIDENCE_MIN) {
    return { action: "hold", reason: "duplicate", classification };
  }
  if (classification.severity === "S4") return { action: "hold", reason: "s4", classification };
  if (classification.severity === "S1" || classification.severity === "S2" || classification.severity === "S3") {
    return { action: "file" };
  }
  return { action: "file", failure: "error" };
}

export function signalClassification(value: Classification) {
  return {
    category: value.category,
    severity: value.severity,
    summary: value.summary,
    steps_to_reproduce: value.steps_to_reproduce,
    suspected_area: value.suspected_area,
    duplicate_of: value.duplicate_of,
    duplicate_confidence: value.duplicate_confidence,
    confidence: value.confidence,
    redacted_text: value.redacted_text,
    needs_human: value.needs_human,
    pii_found: value.pii_found,
  };
}

/**
 * Same handler as POST /api/triage/classify, including TRIAGE_API_SECRET.
 * The secret is only placed on this in-process request. It is not logged.
 * Feedback is the `text` field. The handler treats that field as untrusted.
 */
export async function classifyForIntake(feedback: string, open: OpenIssue[]): Promise<IntakeDecision> {
  try {
    const secret = process.env.TRIAGE_API_SECRET?.trim() ?? "";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret) headers.authorization = `Bearer ${secret}`;
    const res = await classifyPost(
      new Request("https://beanbox.internal/api/triage/classify", {
        method: "POST",
        headers,
        body: JSON.stringify({
          text: feedback.slice(0, 8000),
          candidates: candidatesFromOpenIssues(open),
        }),
      }),
    );
    if (!res.ok) {
      console.error(`[feedback] intake classify failed status=${res.status}`);
      return { action: "file", failure: failureCode(`http_${res.status}`) };
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { action: "file", failure: "error" };
    }
    return decideIntake(payload);
  } catch (err) {
    console.error("[feedback] intake classify failed", err instanceof Error ? err.name : "Error");
    return { action: "file", failure: "error" };
  }
}

function failureCode(value: string): string {
  const code = value.replace(/[^a-z0-9_:-]/gi, "").slice(0, 40);
  return code || "error";
}
