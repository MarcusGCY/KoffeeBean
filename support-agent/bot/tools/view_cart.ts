import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { viewCart } from "../lib/shop";

export default defineTool({
  description: "Read the signed-in shopper's cart totals. A discount amount may be present. Never repeat a coupon code.",
  effect: "read",
  inputSchema: z.object({}),
  async execute(input, ctx) {
    return viewCart(ctx.session.auth, input);
  },
});
