import { NextResponse } from "next/server";
import { dbFailure, requireShopper } from "@/lib/store-http";
import { readActivityView } from "@/lib/store-meta";

/** This shopper's agent audit trail, newest first, with the undo deadline of each order that can still be undone. */
export async function GET() {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json(await readActivityView(auth.userId), { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    return dbFailure(err);
  }
}
