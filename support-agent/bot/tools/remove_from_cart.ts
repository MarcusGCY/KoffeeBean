import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { proposeRemoveFromCart } from "../lib/shop";

export default defineTool({
  description:
    "Prepare removing a quantity of one product from the cart. Returns a pending action. The cart does not change until the shopper presses Confirm.",
  effect: "write",
  inputSchema: z.object({
    productId: z.string().min(1).max(80),
    qty: z.number().int().min(1).max(99).optional(),
  }),
  async execute(input, ctx) {
    return proposeRemoveFromCart(ctx.session.auth, input);
  },
});
