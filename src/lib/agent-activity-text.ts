/** Agent activity types and wording. Client-safe: no server imports. */

export type ActivityStatus = "waiting" | "done" | "declined" | "undone";

export const ACTIVITY_ACTIONS = [
  "suggest",
  "add_to_cart",
  "add_many",
  "update_cart_qty",
  "remove_from_cart",
  "apply_coupon",
  "place_order",
  "cancel_order",
  "report_problem",
  "consent",
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

/**
 * One row of the agent audit trail. `id` is stable for one action's lifecycle: the same entry moves
 * waiting -> done -> undone, and `ts` is the time of the latest change. `consent` is the `consentAt`
 * time of the consent that covered the action, or null. `subject` is a short product list or label
 * used to word the row. Neither field holds chat text, emails, or card data.
 */
export type ActivityEntry = {
  id: string;
  ts: string;
  agent: string;
  action: ActivityAction;
  subject: string;
  reason: string;
  amountCents: number | null;
  orderId: string | null;
  consent: string | null;
  status: ActivityStatus;
};

export const STATUS_LABEL: Record<ActivityStatus, string> = {
  waiting: "Waiting for you",
  done: "Done",
  declined: "Declined",
  undone: "Undone",
};

export const BARISTA = "barista";

export function agentDisplayName(agent: string): string {
  if (agent === BARISTA) return "Barista";
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

function sgd(cents: number): string {
  const whole = cents % 100 === 0;
  return `S$${(cents / 100).toFixed(whole ? 0 : 2)}`;
}

const GENERIC: Partial<Record<ActivityAction, [string, string]>> = {
  update_cart_qty: ["has a cart quantity change ready for you to confirm", "changed a cart quantity"],
  remove_from_cart: ["has a cart removal ready for you to confirm", "removed an item from your cart"],
  apply_coupon: ["has a coupon ready for you to confirm", "applied a coupon you typed"],
  cancel_order: ["has an order cancellation ready for you to confirm", "cancelled an order for you"],
  report_problem: ["has a problem report ready for you to send", "sent your problem report"],
};

/** The row's sentence, worded from the entry. Barista rows follow the C mockup. */
export function activitySentence(entry: ActivityEntry, agentName = agentDisplayName(entry.agent)): string {
  const amount = entry.amountCents != null ? `, ${sgd(entry.amountCents)}` : "";
  const what = entry.subject;
  const { action, status } = entry;
  if (action === "consent") {
    return entry.amountCents != null
      ? `You allowed ${agentName} to order up to ${sgd(entry.amountCents)} per order`
      : `You allowed ${agentName} to order for you`;
  }
  if (action === "suggest") {
    if (status === "declined") return `${agentName} suggested a reorder. You said not now.`;
    if (status === "done") return `${agentName} suggested a reorder of ${what}. You said yes.`;
    return `${agentName} has a reorder of ${what} ready for you to confirm${amount}`;
  }
  if (action === "place_order") {
    if (status === "waiting") return `${agentName} has an order ready for you to confirm${amount}`;
    if (status === "declined") return `${agentName} had an order ready${amount}. You said not now.`;
    if (status === "undone") return `${agentName} ordered ${what}${amount}. You undid it.`;
    return `${agentName} ordered ${what}${amount}`;
  }
  if (action === "add_many" || action === "add_to_cart") {
    if (status === "waiting") return `${agentName} has ${what} ready to add to your cart`;
    if (status === "declined") return `${agentName} had ${what} ready for your cart. You said not now.`;
    return `${agentName} added ${what} to your cart`;
  }
  const generic = GENERIC[action];
  if (generic) return `${agentName} ${status === "waiting" ? generic[0] : generic[1]}`;
  return `${agentName} acted for you`;
}

export type ActivityGroup = { label: "Today" | "This week" | "Earlier"; entries: ActivityEntry[] };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Newest first, in Today (same UTC day), This week (last 7 days) and Earlier. Empty groups are dropped. */
export function groupActivity(entries: readonly ActivityEntry[], now: Date): ActivityGroup[] {
  const today = now.toISOString().slice(0, 10);
  const groups: ActivityGroup[] = [
    { label: "Today", entries: [] },
    { label: "This week", entries: [] },
    { label: "Earlier", entries: [] },
  ];
  const sorted = [...entries].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  for (const entry of sorted) {
    const at = Date.parse(entry.ts);
    const group =
      entry.ts.slice(0, 10) === today ? groups[0] : now.getTime() - at < 7 * DAY_MS ? groups[1] : groups[2];
    group?.entries.push(entry);
  }
  return groups.filter((group) => group.entries.length > 0);
}
