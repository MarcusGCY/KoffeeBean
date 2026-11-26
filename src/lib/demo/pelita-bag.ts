/** The Pelita bag, shared by the storefront and the product page for this tab only. */

const KEY = "kb:pelita:bag";

export type PelitaBag = Record<string, number>;

export function readPelitaBag(): PelitaBag {
  if (typeof sessionStorage === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const bag: PelitaBag = {};
    for (const [id, qty] of Object.entries(data)) {
      if (typeof id !== "string" || !id) continue;
      if (typeof qty === "number" && Number.isInteger(qty) && qty > 0 && qty < 100) bag[id] = qty;
    }
    return bag;
  } catch {
    return {};
  }
}

export function writePelitaBag(bag: PelitaBag): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(bag));
  } catch {
    // Private mode can refuse the write. The on-screen bag still updates.
  }
}
