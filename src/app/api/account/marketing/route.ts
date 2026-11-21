import { NextResponse } from "next/server";
import { z } from "zod";
import { bestEffort } from "@/lib/agent-activity";
import { grantMarketing, readMarketing, withdrawMarketing } from "@/lib/marketing-consent";
import { clearWithdrawalPending, markWithdrawalPending } from "@/lib/marketing-sync";
import { MARKETING_CONSENT_VERSION } from "@/lib/marketing-text";
import { dbFailure, readJson, requireShopper, requireWrite } from "@/lib/store-http";
import { mirrorProfileToBi, recordAudit } from "@/lib/store-meta";

const NO_STORE = { "cache-control": "private, no-store" };

/**
 * `consent` must be the literal `true` and `version` must be the wording the shopper was shown, so an opt-in
 * is never implied and is never recorded against wording the shopper did not see.
 */
const Body = z.strictObject({
  consent: z.literal(true),
  version: z.string().max(32),
});

function audit(userId: string, tool: string, summary: string) {
  return bestEffort(recordAudit(userId, { ts: new Date().toISOString(), tool, summary, outcome: "ok" }));
}

export async function GET() {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ marketing: await readMarketing(auth.userId) }, { headers: NO_STORE });
  } catch (err) {
    return dbFailure(err);
  }
}

/** Records the opt-in with the consent version and time, then mirrors the flag to BI. */
export async function PUT(req: Request) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  const payload = await readJson(req);
  if (payload instanceof NextResponse) return payload;
  const parsed = Body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  if (parsed.data.version !== MARKETING_CONSENT_VERSION) {
    return NextResponse.json({ error: "stale_version", version: MARKETING_CONSENT_VERSION }, { status: 409 });
  }
  try {
    const marketing = await grantMarketing(auth.userId);
    await audit(auth.userId, "marketing.consent", `Opted in to marketing (consent ${marketing.version})`);
    await clearWithdrawalPending(auth.userId);
    const biSynced = await mirrorProfileToBi(auth.userId);
    return NextResponse.json({ marketing, biSynced }, { headers: NO_STORE });
  } catch (err) {
    return dbFailure(err);
  }
}

/**
 * Withdraws the opt-in. Auth0 is written first (the source of truth), then the withdrawal is recorded for
 * retry, then BI is written before answering. If the BI write fails the record stays, so
 * `/api/privacy/reconcile-marketing` corrects the row and `/api/bi/profiles` stops listing it meanwhile.
 * `retryQueued` says whether that record exists.
 */
export async function DELETE(req: Request) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  try {
    const marketing = await withdrawMarketing(auth.userId);
    await audit(auth.userId, "marketing.withdraw", "Withdrew marketing consent");
    const recorded = await markWithdrawalPending(auth.userId);
    const biSynced = await mirrorProfileToBi(auth.userId);
    if (biSynced) await clearWithdrawalPending(auth.userId);
    return NextResponse.json({ marketing, biSynced, retryQueued: !biSynced && recorded }, { headers: NO_STORE });
  } catch (err) {
    return dbFailure(err);
  }
}
