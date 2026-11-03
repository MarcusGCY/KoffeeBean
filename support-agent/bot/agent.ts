import { defineAgent } from "@grok/agent-sdk";

/** Standard Composer 2.5. Fast is a separate, more expensive tier. */
const DEFAULT_CHAT_MODEL = "composer-2.5";

/** Runs inside the Next.js server. No Cursor-hosted deploy. */
export default defineAgent({
  name: "BeanBox support",
  description: "BeanBox support for the signed-in shopper. Writes wait for Confirm.",
  model: process.env.CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL,
  // No built-in shell or file tools. Server tools still reach the model over MCP.
  tools: [],
});
