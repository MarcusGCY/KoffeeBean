import { createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** GitHub `X-Hub-Signature-256` check. False when the header or secret is missing. */
export function verifyGithubSignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return safeEqual(signature, expected);
}
