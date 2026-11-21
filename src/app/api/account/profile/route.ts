import { NextResponse } from "next/server";
import { z } from "zod";
import { bestEffort } from "@/lib/agent-activity";
import { MAX_CADENCE_DAYS } from "@/lib/barista-profile";
import {
  auditFor,
  editProfile,
  readProfileView,
  resetProfile,
  setPersonalization,
  type AccountResult,
} from "@/lib/profile-account";
import { dbFailure, readJson, requireShopper, requireWrite } from "@/lib/store-http";
import { recordAudit } from "@/lib/store-meta";
import { ROASTS } from "@/lib/types";

const NO_STORE = { "cache-control": "private, no-store" };

/** Corrections and the personalization switch. Unknown keys are rejected and at least one must be present. */
const Body = z
  .strictObject({
    cadenceDays: z.number().int().min(1).max(MAX_CADENCE_DAYS).nullable().optional(),
    gramsPerDay: z.number().int().min(1).max(100).optional(),
    preferredRoast: z.enum(ROASTS).nullable().optional(),
    personalization: z.enum(["on", "off"]).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), { message: "empty" })
  .refine((body) => body.personalization === undefined || Object.keys(body).length === 1, { message: "mixed" });

async function respond(userId: string, result: AccountResult) {
  if ("error" in result) {
    const status = result.error === "personalization_off" ? 409 : 200;
    if (status === 409) return NextResponse.json({ error: result.error }, { status });
    return NextResponse.json({ profile: await readProfileView(userId), unchanged: true }, { headers: NO_STORE });
  }
  const { tool, summary } = auditFor(result.change);
  await bestEffort(recordAudit(userId, { ts: new Date().toISOString(), tool, summary, outcome: "ok" }));
  return NextResponse.json({ profile: result.view }, { headers: NO_STORE });
}

export async function GET() {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ profile: await readProfileView(auth.userId) }, { headers: NO_STORE });
  } catch (err) {
    return dbFailure(err);
  }
}

export async function PATCH(req: Request) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  const payload = await readJson(req);
  if (payload instanceof NextResponse) return payload;
  const parsed = Body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { personalization, ...edit } = parsed.data;
  try {
    const result = personalization
      ? await setPersonalization(auth.userId, personalization === "on")
      : await editProfile(auth.userId, edit);
    return await respond(auth.userId, result);
  } catch (err) {
    return dbFailure(err);
  }
}

/** Reset: clears corrections and relearns from orders. */
export async function DELETE(req: Request) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  try {
    return await respond(auth.userId, await resetProfile(auth.userId));
  } catch (err) {
    return dbFailure(err);
  }
}
