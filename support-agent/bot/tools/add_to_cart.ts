import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { proposeAddToCart } from "../lib/shop";

export default defineTool({
  description:
    "Prepare adding a catalogue product to the cart. Returns a pending action. The cart does not change until the shopper presses Confirm. Never invent a price.",
  effect: "write",
  inputSchema: z.object({
    productId: z.string().min(1).max(80),
    qty: z.number().int().min(1).max(99).optional(),
  }),
  async execute(input, ctx) {
    return proposeAddToCart(ctx.session.auth, input);
  },
});
