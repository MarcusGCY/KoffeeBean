import { POST as classifyPost } from "@/app/api/triage/classify/route";
import { ClassifyOutput, DUPLICATE_CONFIDENCE_MIN, type ClassifyOutput as Classification } from "@/lib/triage-classify";

export type IntakeDecision =
  | { action: "hold"; reason: "s4" | "duplicate"; classification: Classification }
  | { action: "file"; failure?: string; classification?: Classification; reason?: "regression" };

/** Known bugs the Lead tracks. Only `number` and a file-path `suspected_area`. */
export const INTAKE_CANDIDATES: { number: number; suspected_area: string }[] = [
  { number: 72, suspected_area: "src/lib/images.ts" },
  { number: 14, suspected_area: "src/lib/checkout.ts" },
  { number: 4, suspected_area: "src/lib/cart" },
  { number: 25, suspected_area: "src/lib/cart" },
  { number: 31, suspected_area: "src/data/products.json" },
];

export function intakeCandidates(): { number: number; suspected_area: string }[] {
  return INTAKE_CANDIDATES.map((candidate) => ({
    number: candidate.number,
    suspected_area: candidate.suspected_area,
  }));
}

const NOTE = "Intake classify failed. This report was filed anyway so a real bug is not dropped.";

export function intakeFailureNote(failure: string): string {
  return `**${NOTE}** (${failureCode(failure)})`;
}

/** Map a classify result onto file vs hold. Customer text is not read here. */
export function decideIntake(raw: unknown): IntakeDecision {
  const parsed = ClassifyOutput.safeParse(raw);
  if (!parsed.success) return { action: "file", failure: "error" };
  const classification = parsed.data;
  if (classification.fallback === true) {
    const reason = classification.fallback_reason?.trim() || "fallback";
    const labeled = reason === "fallback" || reason.startsWith("fallback_") ? reason : `fallback_${reason}`;
    return { action: "file", failure: failureCode(labeled), classification };
  }
  if (classification.needs_human) return { action: "file", failure: "needs_human", classification };
  if (classification.duplicate_of != null && classification.duplicate_confidence >= DUPLICATE_CONFIDENCE_MIN) {
    return { action: "hold", reason: "duplicate", classification };
  }
  if (classification.severity === "S4") return { action: "hold", reason: "s4", classification };
  if (classification.severity === "S1" || classification.severity === "S2" || classification.severity === "S3") {
    return { action: "file", classification };
  }
  return { action: "file", failure: "error", classification };
}

export type IntakeWebhook = {
  action: "hold" | "file";
  reason: "s4" | "duplicate" | "bug" | "regression" | "classify_failed";
  severity: string | null;
  duplicate_of: number | null;
  fallback: boolean;
  needs_human: boolean;
  category: string | null;
  summary: string | null;
  confidence: number | null;
  duplicate_confidence: number | null;
  suspected_area: string | null;
  redacted_text: string | null;
  reportedBy: string;
  known_case_url?: string;
};

/** Flat fields the Lead webhook posts. No new issue number. */
export function intakeWebhook(decision: IntakeDecision, reportedBy: string, knownCaseUrl?: string): IntakeWebhook {
  const found = decision.classification;
  const failed = decision.action === "file" && decision.failure != null;
  const reason = decision.action === "hold"
    ? decision.reason
    : decision.reason === "regression"
      ? "regression"
      : failed
        ? "classify_failed"
        : "bug";
  return {
    action: decision.action,
    reason,
    severity: found?.severity ?? null,
    duplicate_of: found?.duplicate_of ?? null,
    fallback: found ? found.fallback === true : true,
    needs_human: found ? found.needs_human : true,
    category: found?.category ?? null,
    summary: found?.summary ?? null,
    confidence: found?.confidence ?? null,
    duplicate_confidence: found?.duplicate_confidence ?? null,
    suspected_area: found?.suspected_area ?? null,
    redacted_text: found?.redacted_text ?? null,
    reportedBy,
    ...(knownCaseUrl ? { known_case_url: knownCaseUrl } : {}),
  };
}

/**
 * Same handler as POST /api/triage/classify, including TRIAGE_API_SECRET.
 * The secret is only placed on this in-process request. It is not logged.
 * Feedback is the `text` field. The handler treats that field as untrusted.
 */
export async function classifyForIntake(feedback: string): Promise<IntakeDecision> {
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
          candidates: intakeCandidates(),
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
