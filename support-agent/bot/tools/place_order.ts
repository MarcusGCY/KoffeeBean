import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { proposePlaceOrder } from "../lib/shop";

export default defineTool({
  description:
    "Prepare placing the order for the current cart. The total comes from the catalogue. Returns a pending action. The order is not placed until the shopper presses Confirm.",
  effect: "write",
  inputSchema: z.object({}),
  async execute(input, ctx) {
    return proposePlaceOrder(ctx.session.auth, input);
  },
});
