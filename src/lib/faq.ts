import { readFileSync } from "node:fs";
import path from "node:path";

const FAQ_PATH = path.join(process.cwd(), "content", "faq.md");

let faqCache: string | undefined;

/** Approved FAQ. Read on the server only; never taken from the client. */
export function loadFaq(): string {
  if (faqCache === undefined) faqCache = readFileSync(FAQ_PATH, "utf8");
  return faqCache;
}
