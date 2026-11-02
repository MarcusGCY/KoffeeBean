import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { proposeReportProblem } from "../lib/shop";

export default defineTool({
  description:
    "Prepare a problem report using the shopper's own words. Returns a pending action. The report is not filed until the shopper presses Confirm.",
  effect: "write",
  inputSchema: z.object({
    message: z.string().min(5).max(2000),
  }),
  async execute(input, ctx) {
    return proposeReportProblem(ctx.session.auth, input);
  },
});
