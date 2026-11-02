import { NextResponse } from "next/server";
import { agentUserId } from "@/lib/agent-auth";
import { ActionBody, proposeAction } from "@/lib/pending-action";
import { dbFailure } from "@/lib/store-http";

/** Prepares a signed confirm action. Does not change the cart, orders, or feedback. */
export async function POST(req: Request) {
  const userId = agentUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = ActionBody.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  try {
    const result = await proposeAction(userId, parsed.data);
    if ("error" in result) return NextResponse.json(result, { status: 400 });
    return NextResponse.json(result);
  } catch (err) {
    return dbFailure(err);
  }
}
