import { guardDemoWrite } from "@/lib/demo/guard";
import { yuuFailure, yuuJson } from "@/lib/yuu/http";
import { simulateYuuBurst } from "@/lib/yuu/simulate";

export const maxDuration = 60;

export async function POST(req: Request) {
  const denied = guardDemoWrite(req);
  if (denied) return denied;
  try {
    const panel = await simulateYuuBurst();
    return yuuJson({ isDemo: true, ...panel });
  } catch (error) {
    return yuuFailure(error, "[yuu] simulate failed");
  }
}
