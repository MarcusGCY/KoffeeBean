import { NextResponse } from "next/server";
import { z } from "zod";
import { MAX_CAP_CENTS, MIN_CAP_CENTS } from "@/lib/agent-cap";
import { updateAgentPrefs } from "@/lib/agent-prefs";
import { dbFailure, readJson, requireShopper, requireWrite } from "@/lib/store-http";
import { getShopperFlags } from "@/lib/store-meta";
import type { AgentPrefs } from "@/lib/store-types";

const NO_STORE = { "cache-control": "private, no-store" };

function view(prefs: AgentPrefs) {
  return {
    consented: Boolean(prefs.consentAt),
    consentAt: prefs.consentAt ?? null,
    capCents: prefs.capCents,
    askEveryOrder: true as const,
    paused: prefs.paused === true,
  };
}

export async function GET() {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ prefs: view((await getShopperFlags(auth.userId)).agentPrefs) }, { headers: NO_STORE });
  } catch (err) {
    return dbFailure(err);
  }
}

/** `askEveryOrder` is not accepted: it is locked on, and unknown keys are rejected. */
const Body = z.strictObject({
  capCents: z.number().int().min(MIN_CAP_CENTS).max(MAX_CAP_CENTS),
  consent: z.literal(true).optional(),
});

/** Saves the per-order cap. `consent: true` records the one-time consent before Barista's first purchase. */
export async function POST(req: Request) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  const payload = await readJson(req);
  if (payload instanceof NextResponse) return payload;
  const parsed = Body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    const current = (await getShopperFlags(auth.userId)).agentPrefs;
    const consentAt = parsed.data.consent ? (current.consentAt ?? new Date().toISOString()) : undefined;
    const prefs = await updateAgentPrefs(auth.userId, {
      capCents: parsed.data.capCents,
      ...(consentAt ? { consentAt } : {}),
    });
    return NextResponse.json({ prefs: view(prefs) }, { headers: NO_STORE });
  } catch (err) {
    return dbFailure(err);
  }
}
