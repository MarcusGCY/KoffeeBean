"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  CHAT_DROPPED,
  CHAT_UNAVAILABLE,
  EMPTY_CHIPS,
  noticeFor,
  sgd,
  takeSseEvents,
  type SseEvent,
} from "@/lib/chat-response";

type ProductCard = {
  id: string;
  name: string;
  price: number;
  image: string;
  why: string;
};

type OrderCard = {
  id: string;
  status: string;
  totalCents: number;
  items: { name: string; qty: number }[];
};

type Entry =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; products: ProductCard[]; order: OrderCard | null; turn: number };

type PendingAction = { actionId: string; summary: string };
type Usual = { productId: string; line: string } | null;

const HISTORY = 6;

export function SupportChat() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([...EMPTY_CHIPS]);
  const [retryText, setRetryText] = useState<string | null>(null);
  const [usual, setUsual] = useState<Usual>(null);
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const generation = useRef(0);

  useEffect(() => {
    const current = generation;
    return () => {
      current.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetch("/api/chat/usual")
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as { usual?: { productId?: unknown; line?: unknown } | null };
      })
      .then((body) => {
        if (cancelled) return;
        const card = body?.usual;
        if (card && typeof card.productId === "string" && typeof card.line === "string") {
          setUsual({ productId: card.productId, line: card.line });
        } else setUsual(null);
      })
      .catch(() => {
        if (!cancelled) setUsual(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  function history(nextEntries: Entry[]) {
    return nextEntries.slice(-HISTORY).map((entry) => ({
      role: entry.role,
      content: entry.content.slice(0, 500),
    }));
  }

  async function sendText(content: string) {
    const text = content.trim();
    if (!text || pending) return;
    const userEntry: Entry = { role: "user", content: text };
    const nextEntries = [...entries, userEntry].slice(-HISTORY);
    const mine = ++generation.current;
    setEntries(nextEntries);
    setDraft("");
    setNotice(null);
    setRetryText(null);
    setStatus(null);
    setPendingAction(null);
    setPending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history(nextEntries) }),
      });
      if (generation.current !== mine) return;
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.includes("text/event-stream")) {
        const body = await readJson(res);
        setNotice(noticeFor(res.status, typeof body?.error === "string" ? body.error : undefined));
        return;
      }
      await readStream(res, (event) => {
        if (generation.current !== mine) return;
        applyEvent(event, {
          onStatus: (line) => setStatus(line),
          onText: (delta) => {
            setEntries((current) =>
              withAssistant(current, mine, delta, [], null, (entry) => ({
                ...entry,
                content: (entry.content + delta).slice(0, 2000),
              })),
            );
          },
          onProducts: (products) => {
            setEntries((current) =>
              withAssistant(current, mine, "", products, null, (entry) => ({ ...entry, products })),
            );
          },
          onOrder: (order) => {
            setEntries((current) =>
              withAssistant(current, mine, "", [], order, (entry) => ({ ...entry, order })),
            );
          },
          onConfirm: (card) => setPendingAction(card),
          onDone: (chips) => {
            if (chips.length) setSuggestions(chips);
            setStatus(null);
          },
          onError: (message, retry) => {
            setNotice(message);
            setRetryText(retry ? text : null);
            setStatus(null);
          },
        });
      });
    } catch {
      if (generation.current === mine) {
        setNotice(CHAT_DROPPED);
        setRetryText(text);
        setStatus(null);
      }
    } finally {
      if (generation.current === mine) setPending(false);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    await sendText(draft);
  }

  async function confirm() {
    if (!pendingAction || pending) return;
    const action = pendingAction;
    setPending(true);
    setNotice(null);
    try {
      const res = await fetch("/api/chat/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: action.actionId }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string; summary?: string } | null;
      if (res.ok && body?.summary) {
        setPendingAction(null);
        setEntries((current) =>
          [...current, { role: "assistant" as const, content: body.summary ?? "", products: [], order: null, turn: 0 }].slice(-HISTORY),
        );
        return;
      }
      setNotice(noticeFor(res.status, body?.message || body?.error));
    } catch {
      setNotice(CHAT_DROPPED);
    } finally {
      setPending(false);
    }
  }

  async function reorder() {
    if (pending) return;
    setPending(true);
    setNotice(null);
    try {
      const res = await fetch("/api/chat/reorder", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { actionId?: unknown; summary?: unknown; error?: string } | null;
      if (res.ok && typeof body?.actionId === "string" && typeof body.summary === "string") {
        setPendingAction({ actionId: body.actionId, summary: body.summary });
        return;
      }
      setNotice(noticeFor(res.status, body?.error));
    } catch {
      setNotice(CHAT_DROPPED);
    } finally {
      setPending(false);
    }
  }

  async function addProduct(id: string) {
    try {
      const res = await fetch("/api/cart/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId: id }),
      });
      const body = (await res.json().catch(() => null)) as { items?: { productId?: string }[] } | null;
      const saved = res.ok && (body?.items ?? []).some((item) => item.productId === id);
      if (!saved) {
        setNotice("That item wasn't added.");
        return;
      }
      setAdded((current) => ({ ...current, [id]: true }));
      setNotice(null);
      window.dispatchEvent(new Event("beanbox-cart"));
    } catch {
      setNotice(CHAT_DROPPED);
    }
  }

  async function undoProduct(id: string) {
    try {
      const res = await fetch("/api/cart/items", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId: id }),
      });
      if (!res.ok) {
        setNotice("That item wasn't removed.");
        return;
      }
      setAdded((current) => ({ ...current, [id]: false }));
      window.dispatchEvent(new Event("beanbox-cart"));
    } catch {
      setNotice(CHAT_DROPPED);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  }

  const chips = draft.length > 0 ? [] : suggestions.slice(0, 3);

  return (
    <div className="fixed bottom-4 left-4 z-10">
      {open && (
        <section
          aria-label="Support chat"
          className="mb-2 flex w-[min(22rem,calc(100vw-2rem))] flex-col rounded-lg border border-stone-300 bg-white text-stone-900 shadow-xl"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-stone-200 pl-3 pr-1">
            <h2 className="text-sm font-semibold">Barista</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close support chat"
              className="inline-flex h-11 w-11 items-center justify-center rounded text-stone-500 hover:bg-stone-100 hover:text-stone-900"
            >
              ✕
            </button>
          </div>
          <div className="max-h-[min(28rem,calc(100dvh-12rem))] space-y-2 overflow-y-auto px-3 py-3" aria-live="polite">
            {usual && (
              <div className="rounded border border-stone-200 p-2">
                <p className="text-sm text-stone-800">{usual.line}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void reorder()}
                    disabled={pending}
                    className="inline-flex min-h-11 items-center justify-center rounded bg-amber-700 px-3 text-sm font-medium text-white disabled:opacity-50"
                  >
                    Reorder
                  </button>
                  <button
                    type="button"
                    onClick={() => void sendText("Something besides my usual")}
                    disabled={pending}
                    className="inline-flex min-h-11 items-center justify-center rounded border border-stone-300 px-3 text-sm text-stone-700 disabled:opacity-50"
                  >
                    Change
                  </button>
                </div>
              </div>
            )}
            {entries.length === 0 && !notice && !usual && (
              <p className="text-sm text-stone-500">Ask about beans or an order.</p>
            )}
            {entries.map((entry, index) =>
              entry.role === "user" ? (
                <p key={index} className="whitespace-pre-wrap break-words text-sm text-stone-900">
                  {entry.content}
                </p>
              ) : (
                <div key={index} className="space-y-2">
                  {entry.content && <p className="whitespace-pre-wrap break-words text-sm text-stone-700">{entry.content}</p>}
                  {entry.products.slice(0, 3).map((product) => (
                    <article key={product.id} className="overflow-hidden rounded border border-stone-200">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={product.image} alt={product.name} className="h-24 w-full object-cover" />
                      <div className="space-y-1 p-2">
                        <p className="text-sm font-medium">{product.name}</p>
                        <p className="text-sm text-stone-600">{product.why}</p>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold">{sgd(product.price)}</span>
                          <button
                            type="button"
                            onClick={() => void (added[product.id] ? undoProduct(product.id) : addProduct(product.id))}
                            className="inline-flex min-h-11 items-center justify-center rounded bg-amber-700 px-3 text-sm font-medium text-white"
                          >
                            {added[product.id] ? "Added ✓ · Undo" : "Add"}
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                  {entry.order && (
                    <div className="rounded border border-stone-200 p-2 text-sm">
                      <p className="font-medium">{entry.order.id}</p>
                      <p className="capitalize text-stone-600">
                        {entry.order.status} · {sgd(entry.order.totalCents)}
                      </p>
                    </div>
                  )}
                </div>
              ),
            )}
            {status && <p className="text-sm text-stone-500">{status}</p>}
            {notice && (
              <p className="whitespace-pre-wrap break-words text-sm text-stone-700">
                {notice}{" "}
                {retryText && (
                  <button type="button" onClick={() => void sendText(retryText)} className="font-medium underline">
                    Retry
                  </button>
                )}
              </p>
            )}
            {pendingAction && (
              <div className="rounded border border-stone-200 p-2">
                <p className="whitespace-pre-wrap break-words text-sm text-stone-700">{pendingAction.summary}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void confirm()}
                    disabled={pending}
                    className="inline-flex min-h-11 items-center justify-center rounded bg-amber-700 px-3 text-sm font-medium text-white disabled:opacity-50"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingAction(null)}
                    disabled={pending}
                    className="inline-flex min-h-11 items-center justify-center rounded border border-stone-300 px-3 text-sm text-stone-700 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
          <p className="border-t border-stone-200 px-3 pt-2 text-xs text-stone-500">
            {"Don't share personal info. Chats are processed by xAI."}
          </p>
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2 pt-2">
              {chips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => void sendText(chip)}
                  disabled={pending}
                  className="rounded-full border border-stone-300 px-3 py-1 text-xs text-stone-700 disabled:opacity-50"
                >
                  {chip}
                </button>
              ))}
            </div>
          )}
          <form onSubmit={(e) => void send(e)} className="flex shrink-0 items-end gap-2 p-2">
            <label htmlFor="support-chat-input" className="sr-only">
              Message
            </label>
            <textarea
              id="support-chat-input"
              value={draft}
              maxLength={500}
              rows={2}
              required
              placeholder="Ask a question"
              disabled={pending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              className="min-h-11 min-w-0 flex-1 resize-none rounded border border-stone-300 px-2 py-2 text-sm disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={pending || draft.trim().length === 0}
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded bg-amber-700 px-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? "Sending…" : "Send"}
            </button>
          </form>
        </section>
      )}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-stone-900 px-4 text-sm font-medium text-white shadow-lg hover:bg-stone-700"
        >
          Support
        </button>
      )}
    </div>
  );
}

function withAssistant(
  current: Entry[],
  turn: number,
  content: string,
  products: ProductCard[],
  order: OrderCard | null,
  update: (entry: Extract<Entry, { role: "assistant" }>) => Extract<Entry, { role: "assistant" }>,
): Entry[] {
  const index = current.findIndex((entry) => entry.role === "assistant" && entry.turn === turn);
  if (index < 0) return [...current, { role: "assistant", content, products, order, turn }];
  return current.map((entry, i) => (i === index && entry.role === "assistant" ? update(entry) : entry));
}

async function readJson(res: Response): Promise<{ error?: unknown } | null> {
  try {
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== "object") {
      console.error("[chat] unparseable response");
      return null;
    }
    return body as { error?: unknown };
  } catch {
    console.error("[chat] unparseable response");
    return null;
  }
}

type Handlers = {
  onStatus: (text: string) => void;
  onText: (delta: string) => void;
  onProducts: (products: ProductCard[]) => void;
  onOrder: (order: OrderCard) => void;
  onConfirm: (card: PendingAction) => void;
  onDone: (suggestions: string[]) => void;
  onError: (message: string, retry: boolean) => void;
};

function applyEvent(event: SseEvent, handlers: Handlers) {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(event.data) as unknown;
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    console.error("[chat] unparseable response");
    handlers.onError(CHAT_UNAVAILABLE, false);
    return;
  }
  if (event.event === "status" && typeof data.text === "string") handlers.onStatus(data.text);
  if (event.event === "text" && typeof data.delta === "string") handlers.onText(data.delta);
  if (event.event === "products" && Array.isArray(data.products)) handlers.onProducts(cardsFrom(data.products));
  if (event.event === "order") {
    const order = orderFrom(data);
    if (order) handlers.onOrder(order);
  }
  if (event.event === "confirm" && typeof data.actionId === "string" && typeof data.summary === "string") {
    handlers.onConfirm({ actionId: data.actionId, summary: data.summary });
  }
  if (event.event === "done") {
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions.filter((item): item is string => typeof item === "string").slice(0, 3) : [];
    handlers.onDone(suggestions);
  }
  if (event.event === "error") {
    handlers.onError(typeof data.message === "string" ? data.message : CHAT_UNAVAILABLE, data.retry === true);
  }
}

function cardsFrom(value: unknown[]): ProductCard[] {
  const cards: ProductCard[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const card = row as Record<string, unknown>;
    if (typeof card.id !== "string" || typeof card.name !== "string" || typeof card.image !== "string") continue;
    if (typeof card.why !== "string" || typeof card.price !== "number") continue;
    cards.push({ id: card.id, name: card.name, price: card.price, image: card.image, why: card.why });
    if (cards.length === 3) break;
  }
  return cards;
}

function orderFrom(data: Record<string, unknown>): OrderCard | null {
  if (typeof data.id !== "string" || typeof data.status !== "string" || typeof data.totalCents !== "number") return null;
  if (!Array.isArray(data.items)) return null;
  const items = data.items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { name?: unknown; qty?: unknown };
    if (typeof row.name !== "string" || typeof row.qty !== "number") return [];
    return [{ name: row.name, qty: row.qty }];
  });
  return { id: data.id, status: data.status, totalCents: data.totalCents, items };
}

async function readStream(res: Response, onEvent: (event: SseEvent) => void) {
  const reader = res.body?.getReader();
  if (!reader) {
    console.error("[chat] unparseable response");
    throw new Error("no_body");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    buffer += decoder.decode(step.value, { stream: true });
    const taken = takeSseEvents(buffer);
    buffer = taken.rest;
    for (const event of taken.events) onEvent(event);
  }
  const tail = takeSseEvents(`${buffer}\n\n`);
  for (const event of tail.events) onEvent(event);
}
