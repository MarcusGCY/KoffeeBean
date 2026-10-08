const ISSUE_REF = /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?):?\s+#(\d+)/gi;

/** Issue numbers named with a GitHub closing keyword, in order, without duplicates. */
export function issueNumbersFromText(text: string): number[] {
  const seen = new Set<number>();
  for (const match of text.matchAll(ISSUE_REF)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return [...seen];
}
