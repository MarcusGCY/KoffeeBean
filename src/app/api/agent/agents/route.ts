import { NextResponse } from "next/server";
import { z } from "zod";
import { MAX_CAP_CENTS, MIN_CAP_CENTS } from "@/lib/agent-cap";
import { changeAgent, readAgentsView } from "@/lib/connected-agents";
import { dbFailure, readJson, requireShopper, requireWrite } from "@/lib/store-http";

const NO_STORE = { "cache-control": "private, no-store" };

/** Barista and the (demo) outside agents with their limits, pause state and last activity. */
export async function GET() {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json(await readAgentsView(auth.userId), { headers: NO_STORE });
  } catch (err) {
    return dbFailure(err);
  }
}

const agentId = z.string().regex(/^[a-z0-9-]{1,32}$/);
const Body = z.discriminatedUnion("action", [
  z.strictObject({ agentId, action: z.enum(["pause", "resume", "revoke"]) }),
  z.strictObject({ agentId, action: z.literal("limit"), capCents: z.number().int().min(MIN_CAP_CENTS).max(MAX_CAP_CENTS) }),
]);

const STATUS = { not_found: 404, revoked: 409, already_revoked: 409, no_change: 409, invalid_cap: 400 } as const;

/** Pause, resume, revoke (outside agents only) or change the per-order limit. Every change is audited. */
export async function POST(req: Request) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  const payload = await readJson(req);
  if (payload instanceof NextResponse) return payload;
  const parsed = Body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { agentId: id, ...act } = parsed.data;

  try {
    const result = await changeAgent(auth.userId, id, act);
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: STATUS[result.error] });
    return NextResponse.json(result.view, { headers: NO_STORE });
  } catch (err) {
    return dbFailure(err);
  }
}
