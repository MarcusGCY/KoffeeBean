const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\d)(?:\+65[\s-]?)?[689]\d{3}[\s-]?\d{4}(?!\d)/g;
const CARD = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;
const STREET =
  /\b\d{1,4}\s+(?:[A-Za-z]+\s+){1,4}(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Boulevard|Blvd|Crescent|Close|Walk|Terrace)\b/g;
const POSTAL = /\bSingapore\s+\d{6}\b|\b[Ss]\d{6}\b/g;

export type PiiType = "email" | "phone" | "card" | "address" | "postal";

export function redactText(input: string): { text: string; types: PiiType[] } {
  const types = new Set<PiiType>();
  let text = input.replace(CARD, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return match;
    types.add("card");
    return "[redacted-card]";
  });
  text = text.replace(EMAIL, () => {
    types.add("email");
    return "[redacted-email]";
  });
  text = text.replace(PHONE, () => {
    types.add("phone");
    return "[redacted-phone]";
  });
  text = text.replace(STREET, () => {
    types.add("address");
    return "[redacted-address]";
  });
  text = text.replace(POSTAL, () => {
    types.add("postal");
    return "[redacted-postal]";
  });
  return { text, types: [...types] };
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
