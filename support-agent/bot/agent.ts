import { defineAgent } from "@grok/agent-sdk";

/** Runs inside the Next.js server. No Cursor-hosted deploy. */
export default defineAgent({
  name: "BeanBox support",
  description: "BeanBox support for the signed-in shopper. Writes wait for Confirm.",
  // No built-in shell or file tools. Server tools still reach the model over MCP.
  tools: [],
});
