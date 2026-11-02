import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { proposeApplyCoupon } from "../lib/shop";

export default defineTool({
  description:
    "Prepare applying a coupon code the shopper typed in this chat. Do not invent, guess, or list codes. Returns a pending action. The cart does not change until the shopper presses Confirm.",
  effect: "write",
  inputSchema: z.object({
    code: z.string().min(1).max(40),
  }),
  async execute(input, ctx) {
    return proposeApplyCoupon(ctx.session.auth, input);
  },
});
