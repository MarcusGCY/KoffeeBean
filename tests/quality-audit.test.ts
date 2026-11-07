import { beforeEach, describe, expect, it, vi } from "vitest";

const getIssue = vi.hoisted(() => vi.fn());
const listComments = vi.hoisted(() => vi.fn());
const comment = vi.hoisted(() => vi.fn());
const readAdmin = vi.hoisted(() => vi.fn());
const fixIssue = vi.hoisted(() => vi.fn());

vi.mock("@/lib/github", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github")>("@/lib/github");
  return { ...actual, getIssue, listComments, comment };
});
vi.mock("@/lib/demo-session", () => ({ readAdmin }));
vi.mock("@/lib/fix", () => ({ fixIssue }));

import { GET as ack } from "@/app/api/quality/ack/route";
import { GET as auditRoute } from "@/app/api/quality/audit/route";
import { fixResultComment, fixRunComment } from "@/lib/fix-marker";
import { assembleAudit } from "@/lib/quality-audit";
import {
  fixCompletedMessage,
  fixStartedMessage,
  parseAudit,
  parseCase,
  qualityAckToken,
  qualityCase,
  redactAudit,
  reviewRequestMessage,
  sealEvent,
  buildEvent,
  caseMarker,
} from "@/lib/quality-case";
import { reproMarker } from "@/lib/reproduce";

const SECRET = "quality-audit-secret";
const AGENT = "bc-d7dc6308-e103-4bd7-9c90-8b64a0816573";
const RUN = "run-ff80100e-2385-4236-a806-fa7ecdbd02a4";
const SHA = "04a1fde8aa77d59d40ead7fd1091fa2e4ae234a1";

beforeEach(() => {
  getIssue.mockReset();
  listComments.mockReset();
  comment.mockReset();
  readAdmin.mockReset();
  fixIssue.mockReset();
  process.env.APPROVAL_SECRET = SECRET;
  process.env.APP_URL = "http://localhost:3000";
  fixIssue.mockRejectedValue(new Error("ack must not launch"));
});

describe("quality messages", () => {
  const quality = qualityCase({ caseId: "kb-0123456789abcdef", severity: "S2", reason: "bug", category: "images" });

  it("keeps severity on the review, launch, and completion text", () => {
    expect(quality).toBeTruthy();
    const review = reviewRequestMessage({
      number: 90,
      title: "House Espresso image not loading",
      summary: "The tile 404s.",
      ...quality!,
    });
    const started = fixStartedMessage({
      number: 90,
      title: "House Espresso image not loading",
      agentId: AGENT,
      runId: RUN,
      ...quality!,
    });
    const completed = fixCompletedMessage({
      number: 90,
      title: "House Espresso image not loading",
      status: "finished",
      prUrl: "https://github.com/acme/beanbox/pull/91",
      ...quality!,
    });
    for (const message of [review, started, completed]) {
      expect(message.startsWith("Severity S2 · images · bug")).toBe(true);
      expect(message).not.toContain("@");
    }
    expect(review).toContain("Do not ask Triage or Engineering to start work.");
    expect(started).toContain("Do not launch another agent");
    expect(started).toContain("does not launch work");
    expect(completed).toContain("not verification");
    expect(completed).toContain("does not merge and does not launch");
  });

  it("drops email, subject, and bearer values from audit text", () => {
    const clean = redactAudit("ada@example.com google-oauth2|103 Bearer secret-token");
    expect(clean).not.toContain("ada@example.com");
    expect(clean).not.toContain("google-oauth2");
    expect(clean).not.toContain("secret-token");
  });
});

describe("assembleAudit", () => {
  it("reconstructs issue 90 without claiming webhook delivery or room acknowledgement", () => {
    const body = [
      reproMarker("tests/repro/house-espresso-image.test.ts", "beanbox-triage/house-espresso-image-bc-84c2c", SHA),
      "",
      "The tile 404s.",
      "",
      "**Check:** https://github.com/MarcusGCY/KoffeeBean/actions/runs/42328169148",
      "",
      "**Reported by:** Marcus (ada@example.com)",
      "Auth0 user id: `google-oauth2|103789025832584535503`",
    ].join("\n");
    const view = assembleAudit({
      number: 90,
      title: "House Espresso ada@example.com",
      body,
      state: "open",
      labels: ["user-feedback", "approved"],
      comments: [
        { body: fixRunComment({ agentId: AGENT, runId: RUN, startedAt: 1794018379743 }) },
        {
          body: fixResultComment("Cursor opened a fix: https://github.com/MarcusGCY/KoffeeBean/pull/91", {
            prNumber: 91,
            prUrl: "https://github.com/MarcusGCY/KoffeeBean/pull/91",
            head: "cursor/fix-house-espresso-image-6573",
          }),
        },
        { body: "<!-- beanbox-audit {\"stage\":\"engineering_ack\",\"status\":\"acknowledged\"} not-a-signature -->" },
      ],
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain("google-oauth2");
    expect(serialized).not.toContain("ignored");
    expect(view.title).toContain("[redacted-email]");
    expect(view.tracking.fixLaunched).toBe(true);
    expect(view.tracking.engineeringAdoption).toBe("unacknowledged");
    expect(view.tracking.verification).toBe("unacknowledged");
    expect(view.tracking.notifyFixStarted).toBe("not_recorded");
    expect(view.tracking.notifyFixCompleted).toBe("not_recorded");
    expect(view.tracking.verificationAcceptsPullRequestSelfReport).toBe(false);
    expect(view.tracking.appLauncher).toBe("single");
    expect(view.next).toMatchObject({
      stage: "verification",
      owner: "verification",
    });
    expect(view.unresolved.map((item) => item.stage)).toEqual(["engineering_ack", "verification"]);
    expect(view.stages.find((stage) => stage.stage === "fix_launch")).toMatchObject({
      source: "reconstructed",
      agentId: AGENT,
      runId: RUN,
      externalAck: "none",
    });
    expect(view.stages.find((stage) => stage.stage === "fix_result")).toMatchObject({
      pr: 91,
      source: "reconstructed",
    });
    expect(view.external.engineeringChat).toContain("not observed");
    expect(view.external.vercelDeploy).toContain("not observed");
  });

  it("trusts a signed adoption ack and still does not treat it as a launch", () => {
    const quality = qualityCase({ caseId: "kb-0123456789abcdef", severity: "S2", reason: "bug", category: "images" })!;
    const event = buildEvent({
      actionId: "engineering_ack:90",
      caseId: quality.caseId,
      correlationId: quality.correlationId,
      stage: "engineering_ack",
      status: "acknowledged",
      at: "2026-11-07T02:30:00.000Z",
      actor: "signed-link",
      issue: 90,
      pr: null,
      agentId: null,
      runId: null,
      severity: "S2",
      reason: "bug",
      category: "images",
      evidence: "signed adoption link",
      attempt: 1,
      nextOwner: "app",
      blocker: "acknowledgement does not launch an agent",
      externalAck: "acknowledged",
    });
    const view = assembleAudit({
      number: 90,
      title: "House Espresso",
      body: caseMarker(quality),
      state: "open",
      labels: ["user-feedback", "approved"],
      comments: [{ body: sealEvent(event) }],
    });
    expect(view.caseId).toBe(quality.caseId);
    expect(view.tracking.fixLaunched).toBe(false);
    expect(view.tracking.engineeringAdoption).toBe("acknowledged");
    expect(view.next).toMatchObject({
      stage: "fix_launch",
      blocker: "fix not launched; acknowledgement does not launch an agent",
    });
    expect(parseCase(caseMarker(quality))?.severity).toBe("S2");
    expect(parseAudit("<!-- beanbox-audit {\"actionId\":\"engineering_ack:90\"} aaaa -->")).toBeUndefined();
  });
});

describe("acknowledgement route", () => {
  const comments: { id: number; body: string }[] = [];

  beforeEach(() => {
    comments.length = 0;
    getIssue.mockResolvedValue({
      number: 90,
      title: "House Espresso",
      body: "no marker",
      url: "https://github.com/acme/beanbox/issues/90",
      state: "open",
      labels: ["user-feedback", "approved"],
    });
    listComments.mockImplementation(async () => comments.map((item) => ({ ...item })));
    comment.mockImplementation(async (_issue: number, body: string) => {
      comments.push({ id: comments.length + 1, body });
    });
  });

  it("records engineering adoption once and does not launch or merge", async () => {
    const token = qualityAckToken(90, "engineering");
    const first = await ack(new Request(`http://localhost:3000/api/quality/ack?issue=90&stage=engineering&token=${token}`));
    const second = await ack(new Request(`http://localhost:3000/api/quality/ack?issue=90&stage=engineering&token=${token}`));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      status: "acknowledged",
      stage: "engineering",
      launchesAgent: false,
      merges: false,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "already-acknowledged", launchesAgent: false, merges: false });
    expect(comment).toHaveBeenCalledTimes(1);
    expect(fixIssue).not.toHaveBeenCalled();
    expect(parseAudit(comments[0].body)?.stage).toBe("engineering_ack");
  });

  it("rejects a tampered link", async () => {
    const res = await ack(new Request("http://localhost:3000/api/quality/ack?issue=90&stage=engineering&token=1.aa"));
    expect(res.status).toBe(403);
    expect(comment).not.toHaveBeenCalled();
    expect(fixIssue).not.toHaveBeenCalled();
  });
});

describe("audit read route", () => {
  it("hides the trail unless the caller is an admin", async () => {
    readAdmin.mockResolvedValue(null);
    const hidden = await auditRoute(new Request("http://localhost:3000/api/quality/audit?issue=90"));
    expect(hidden.status).toBe(404);
    expect(getIssue).not.toHaveBeenCalled();

    readAdmin.mockResolvedValue({ id: "auth0|admin", email: "owner@example.com" });
    getIssue.mockResolvedValue({
      number: 90,
      title: "House Espresso",
      body: "Reported by ada@example.com",
      url: "https://github.com/acme/beanbox/issues/90",
      state: "open",
      stateReason: null,
      labels: ["awaiting-review", "user-feedback"],
    });
    listComments.mockResolvedValue([]);
    const shown = await auditRoute(new Request("http://localhost:3000/api/quality/audit?issue=90"));
    expect(shown.status).toBe(200);
    const body = await shown.json();
    expect(body.issue).toBe(90);
    expect(body.tracking.notifyFixStarted).toBe("not_recorded");
    expect(JSON.stringify(body)).not.toContain("ada@example.com");
    expect(JSON.stringify(body)).not.toContain("owner@example.com");
  });
});
