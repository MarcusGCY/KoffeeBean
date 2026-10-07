import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

const sign = (issue: number, decision: string) =>
  createHmac("sha256", env("APPROVAL_SECRET")).update(`${issue}:${decision}`).digest("hex");

export function token(issue: number, decision: "approve" | "reject") {
  return sign(issue, decision);
}

export function verify(issue: number, decision: string, t: string) {
  const a = Buffer.from(sign(issue, decision));
  const b = Buffer.from(t);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function reviewLinks(issue: number) {
  const base = env("APP_URL");
  const q = (d: "approve" | "reject") =>
    `${base}/api/review?issue=${issue}&decision=${d}&token=${token(issue, d)}`;
  return { approve: q("approve"), reject: q("reject"), page: `${base}/review/${issue}` };
}
