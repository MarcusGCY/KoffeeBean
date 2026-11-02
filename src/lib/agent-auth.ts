import { verifySupportToken } from "./support-token";

/** Shopper id from the agent token only. Query and body user ids are ignored. */
export function agentUserId(req: Request): string | null {
  const secret = process.env.SUPPORT_AGENT_SECRET?.trim();
  if (!secret) return null;
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const token = match?.[1];
  if (!token) return null;
  return verifySupportToken(token, secret)?.userId ?? null;
}
