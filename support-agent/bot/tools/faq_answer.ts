import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { faqAnswer } from "../lib/shop";

export default defineTool({
  description: "Read the approved BeanBox FAQ (content/faq.md). Answer shop questions from this text only.",
  effect: "read",
  inputSchema: z.object({
    question: z.string().max(500).optional(),
  }),
  async execute(input, ctx) {
    return faqAnswer(ctx.session.auth, input);
  },
});
