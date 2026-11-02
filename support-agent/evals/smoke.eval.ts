import { defineEval } from "@grok/agent-sdk/evals";

/** Smoke case. Needs a Cursor credential and a reachable shop. Not part of `npm test`. */
export default defineEval({
  tags: ["smoke"],
  description: "A bag-size question is answered from the FAQ tool.",
  async test(t) {
    await t.send("What bag sizes are available?");
    t.succeeded();
    t.calledTool("faq_answer");
  },
});
