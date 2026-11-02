import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { proposeCancelOrder } from "../lib/shop";

export default defineTool({
  description:
    "Prepare cancelling one of the signed-in shopper's orders by its BB- id. Returns a pending action. The order is not cancelled until the shopper presses Confirm.",
  effect: "write",
  inputSchema: z.object({
    orderId: z.string().min(1).max(40),
  }),
  async execute(input, ctx) {
    return proposeCancelOrder(ctx.session.auth, input);
  },
});
