import { bearerAuth, httpChannel } from "@grok/agent-sdk/channels";
import { verifySupportToken } from "../lib/token";

/**
 * Loopback sessions only. The Next route signs the shopper id with APPROVAL_SECRET.
 * Tools read that principal and ignore any user id from the model.
 */
export default httpChannel({
  auth: [
    bearerAuth(async (token) => {
      const secret = process.env.APPROVAL_SECRET?.trim();
      if (!secret) return null;
      const verified = verifySupportToken(token, secret);
      if (!verified) return null;
      return {
        authenticator: "bearer",
        principalId: verified.userId,
        principalType: "user" as const,
      };
    }),
  ],
});
