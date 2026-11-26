import { guardDemoWrite } from "@/lib/demo/guard";
import { yuuJson } from "@/lib/yuu/http";

export const maxDuration = 30;

/** Retired. Purchases come from a signed-in shopper, not the simulated personas. */
export async function POST(req: Request) {
  const denied = guardDemoWrite(req);
  if (denied) return denied;
  return yuuJson(
    { error: "retired", message: "Simulated yuu shoppers are retired. Sign in and use Buy with yuu." },
    410,
  );
}
