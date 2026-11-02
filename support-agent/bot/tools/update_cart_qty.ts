import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { proposeUpdateQty } from "../lib/shop";

export default defineTool({
  description:
    "Prepare setting one cart line to a quantity from 1 to 99. Returns a pending action. The cart does not change until the shopper presses Confirm.",
  effect: "write",
  inputSchema: z.object({
    productId: z.string().min(1).max(80),
    qty: z.number().int().min(1).max(99),
  }),
  async execute(input, ctx) {
    return proposeUpdateQty(ctx.session.auth, input);
  },
});
