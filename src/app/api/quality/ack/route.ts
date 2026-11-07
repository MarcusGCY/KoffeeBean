import { NextResponse } from "next/server";
import { isSameOrigin, verifyDemoCsrf } from "@/lib/demo-auth";
import { readAdmin } from "@/lib/demo-session";
import { githubHttpStatus } from "@/lib/github";
import { QualityDecisionError, recordQualityDecision } from "@/lib/quality-audit";
import * as gh from "@/lib/github";
import { readAckQuery, verifierRef, verifyQualityAck } from "@/lib/quality-case";

export const maxDuration = 60;

/**
 * GET confirms the bound link and writes nothing.
 * POST, by an authenticated admin from this origin, records adopt, GO, or NO-GO.
 */
export async function GET(req: Request) {
  const binding = readAckQuery(new URL(req.url));
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!binding) return json({ error: "Invalid or tampered link" }, 403);
  const verdict = checkToken(binding, token);
  if (verdict !== "ok") return verdict;
  return json({
    status: "confirmation",
    mutates: false,
    recorded: false,
    launchesAgent: false,
    merges: false,
    countsAsGo: false,
    stage: binding.stage,
    issue: binding.issue,
    caseId: binding.caseId,
    runId: binding.runId,
    pr: binding.pr,
    head: binding.head,
    note: "Opening this URL records nothing. An admin POST records the decision. Engineering adoption is not a launch. A verification GO requires evidence for this head. ACK is not GO. NO-GO is not a pass.",
  });
}

export async function POST(req: Request) {
  const admin = await readAdmin();
  if (!admin) return json({ error: "Not found" }, 404);
  if (!isSameOrigin(req)) return json({ error: "Cross-site request rejected. Nothing was recorded." }, 403);
  const url = new URL(req.url);
  const binding = readAckQuery(url);
  const token = url.searchParams.get("token") ?? "";
  if (!binding) return json({ error: "Invalid or tampered link", recorded: false }, 403);
  const verdict = checkToken(binding, token);
  if (verdict !== "ok") return verdict;

  let body: { decision?: unknown; evidence?: unknown; csrf?: unknown };
  try {
    body = await readBody(req);
  } catch {
    return json({ error: "Expected JSON or a form body. Nothing was recorded.", recorded: false }, 400);
  }
  if (typeof body.csrf !== "string" || !verifyDemoCsrf(admin.id, body.csrf)) {
    return json({ error: "CSRF check failed. Nothing was recorded.", recorded: false }, 403);
  }
  const decision = body.decision;
  if (decision !== "adopt" && decision !== "go" && decision !== "no-go") {
    return json({ error: "Decision must be adopt, go, or no-go. Nothing was recorded.", recorded: false }, 400);
  }
  const evidence = typeof body.evidence === "string" ? body.evidence : "";
  let currentHead: string | null = null;
  if (binding.stage === "verification" && binding.pr > 0) {
    try {
      const pull = await gh.getPullRequest(binding.pr);
      currentHead = pull?.headSha ?? null;
    } catch (error) {
      console.error(`[quality] head_read_failed issue=${binding.issue} pr=${binding.pr} case=${binding.caseId} error=github_read_failed name=${error instanceof Error ? error.name : "Error"}`);
      return json({
        error: "The pull request head could not be read. Nothing was recorded.",
        recorded: false,
        issue: binding.issue,
        caseId: binding.caseId,
        recovery: "Retry this POST after the head can be read. There is no background outbox.",
      }, 503);
    }
  }
  try {
    const result = await recordQualityDecision({
      binding,
      decision,
      evidence,
      verifierRef: verifierRef(admin.id),
      currentHead,
    });
    return json({
      status: result.write.duplicate ? "already-recorded" : "recorded",
      recorded: true,
      duplicate: result.write.duplicate,
      dedup: result.write.dedup,
      launchesAgent: false,
      merges: false,
      countsAsGo: decision === "go" && !result.write.duplicate ? true : decision === "go",
      decision,
      stage: binding.stage,
      issue: binding.issue,
      caseId: binding.caseId,
      runId: binding.runId,
      pr: binding.pr,
      head: binding.head,
      verifierRef: verifierRef(admin.id),
      actionId: result.write.actionId,
      next: result.audit.next,
    });
  } catch (error) {
    if (error instanceof QualityDecisionError) {
      return json({
        error: error.message,
        code: error.code,
        recorded: false,
        issue: binding.issue,
        caseId: binding.caseId,
        stage: binding.stage,
        pr: binding.pr,
        head: binding.head,
        recovery: error.status === 503
          ? "Retry this POST. Nothing was saved. There is no background outbox."
          : "Nothing was recorded.",
      }, error.status);
    }
    if (githubHttpStatus(error) === 404) return json({ error: "Not found", recorded: false }, 404);
    console.error(`[quality] decision_failed issue=${binding.issue} case=${binding.caseId} stage=${binding.stage} error=unhandled name=${error instanceof Error ? error.name : "Error"}`);
    return json({
      error: "The decision could not be recorded.",
      recorded: false,
      issue: binding.issue,
      caseId: binding.caseId,
      recovery: "Retry this POST. Nothing was saved. There is no background outbox.",
    }, 503);
  }
}

async function readBody(req: Request): Promise<{ decision?: unknown; evidence?: unknown; csrf?: unknown }> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    return await req.json() as { decision?: unknown; evidence?: unknown; csrf?: unknown };
  }
  const form = await req.formData();
  return {
    decision: form.get("decision") ?? undefined,
    evidence: form.get("evidence") ?? undefined,
    csrf: form.get("csrf") ?? undefined,
  };
}

function checkToken(binding: NonNullable<ReturnType<typeof readAckQuery>>, token: string): "ok" | Response {
  try {
    const verdict = verifyQualityAck(binding, token);
    if (verdict === "expired") return json({ error: "This link has expired.", recorded: false }, 403);
    if (verdict !== "ok") return json({ error: "Invalid or tampered link", recorded: false }, 403);
    return "ok";
  } catch (error) {
    console.error("[quality] ack link check failed", error instanceof Error ? error.name : "Error");
    return json({ error: "Acknowledgement links are not configured.", recorded: false }, 503);
  }
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}
