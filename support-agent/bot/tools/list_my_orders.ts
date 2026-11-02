import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { listMyOrders } from "../lib/shop";

export default defineTool({
  description: "List the signed-in shopper's orders and their status. Does not include other shoppers.",
  effect: "read",
  inputSchema: z.object({}),
  async execute(input, ctx) {
    return listMyOrders(ctx.session.auth, input);
  },
});
