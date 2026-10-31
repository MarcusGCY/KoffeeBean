import { NextResponse } from "next/server";
import { getCart } from "@/lib/store-db";
import { dbFailure, requireShopper } from "@/lib/store-http";

export async function GET() {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json(await getCart(auth.userId));
  } catch (err) {
    return dbFailure(err);
  }
}
