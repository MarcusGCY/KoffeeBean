import { defineAgent } from "@grok/agent-sdk";

/**
 * Hostname of the BeanBox app the tools call. No scheme and no path.
 * Set this to the production host before `agent-sdk deploy`, then redeploy
 * if it changes. Example: "koffeebean.vercel.app".
 * It must be the host in the KOFFEEBEAN_URL secret.
 */
const SHOP_HOST: string = "";

export default defineAgent({
  name: "BeanBox support",
  description: "Read-only BeanBox support for the signed-in shopper.",
  // No built-in shell or file tools. Server tools still reach the model over MCP.
  // local.sandbox stays off: with it on, MCP tool calls fail closed.
  tools: [],
  hosting: {
    ...(SHOP_HOST ? { egressDomains: [SHOP_HOST] } : {}),
    secretNames: ["SUPPORT_AGENT_SECRET", "KOFFEEBEAN_URL"],
  },
});
