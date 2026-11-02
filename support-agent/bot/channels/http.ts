import { bearerAuth, httpChannel } from "@grok/agent-sdk/channels";
import { verifySupportToken } from "../lib/token";

/** Accepts the shop's short-lived HMAC token and sets the principal to that shopper. */
export default httpChannel({
  auth: [
    bearerAuth(async (token) => {
      const secret = process.env.SUPPORT_AGENT_SECRET?.trim();
      if (!secret) return null;
      const verified = verifySupportToken(token, secret);
      if (!verified) return null;
      return {
        authenticator: "bearer",
        principalId: verified.userId,
        principalType: "user",
      };
    }),
  ],
});
