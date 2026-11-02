import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { getOrderStatus } from "../lib/shop";

export default defineTool({
  description: "Read one of the signed-in shopper's orders by its BB- order id. Missing orders are not found.",
  effect: "read",
  inputSchema: z.object({
    orderId: z.string().min(1).max(40),
  }),
  async execute(input, ctx) {
    return getOrderStatus(ctx.session.auth, input);
  },
});
