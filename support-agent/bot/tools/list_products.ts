import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { listProducts } from "../lib/shop";

export default defineTool({
  description: "List BeanBox products for sale, with names and prices in cents. Does not include coupon codes.",
  effect: "read",
  inputSchema: z.object({}),
  async execute(input, ctx) {
    return listProducts(ctx.session.auth, input);
  },
});
