import { NextResponse } from "next/server";
import { z } from "zod";
import { bestEffort } from "@/lib/agent-activity";
import { clearLocation, grantLocation, readLocation } from "@/lib/location-consent";
import { parsePostcode } from "@/lib/location-text";
import { dbFailure, readJson, requireShopper, requireWrite } from "@/lib/store-http";
import { emitBiProfile, recordAudit } from "@/lib/store-meta";

const NO_STORE = { "cache-control": "private, no-store" };

/** `consent` must be the literal `true`: the opt-in is never implied by sending a postcode. */
const Body = z.strictObject({
  postcode: z.string().max(12),
  consent: z.literal(true),
});

function audit(userId: string, tool: string, summary: string) {
  return bestEffort(recordAudit(userId, { ts: new Date().toISOString(), tool, summary, outcome: "ok" }));
}

export async function GET() {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ location: await readLocation(auth.userId) }, { headers: NO_STORE });
  } catch (err) {
    return dbFailure(err);
  }
}

/** Saves the postcode and records the consent time and purpose. */
export async function PUT(req: Request) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  const payload = await readJson(req);
  if (payload instanceof NextResponse) return payload;
  const parsed = Body.safeParse(payload);
  const postcode = parsed.success ? parsePostcode(parsed.data.postcode) : null;
  if (!parsed.success || !postcode) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  try {
    const location = await grantLocation(auth.userId, postcode);
    await audit(auth.userId, "location.consent", "Allowed use of postal district");
    emitBiProfile(auth.userId);
    return NextResponse.json({ location }, { headers: NO_STORE });
  } catch (err) {
    return dbFailure(err);
  }
}

/** Withdraws consent and clears the stored postcode. */
export async function DELETE(req: Request) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  try {
    await clearLocation(auth.userId);
    await audit(auth.userId, "location.withdraw", "Withdrew postcode consent and cleared it");
    emitBiProfile(auth.userId);
    return NextResponse.json({ location: null }, { headers: NO_STORE });
  } catch (err) {
    return dbFailure(err);
  }
}
