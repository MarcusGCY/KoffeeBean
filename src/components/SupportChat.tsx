"use client";

import { useEffect, useRef, useState } from "react";
import { CHAT_DROPPED, CHAT_UNAVAILABLE, noticeFor } from "@/lib/chat-response";

type Turn = { role: "user" | "assistant"; content: string };
type PendingAction = { actionId: string; summary: string };

const POLL_MS = 1500;
const POLL_LIMIT = 200;

type ChatJson = {
  status?: unknown;
  reply?: unknown;
  error?: unknown;
  httpStatus?: unknown;
  turnId?: unknown;
  pendingAction?: { actionId?: unknown; summary?: unknown };
};

async function readJson(res: Response): Promise<ChatJson | null> {
  try {
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== "object") {
      console.error("[chat] unparseable response");
      return null;
    }
    return body as ChatJson;
  } catch {
    console.error("[chat] unparseable response");
    return null;
  }
}

export function SupportChat() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = generation;
    return () => {
      current.current += 1;
    };
  }, []);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || pending) return;

    const next = [...turns, { role: "user" as const, content }].slice(-6);
    const mine = ++generation.current;
    setTurns(next);
    setDraft("");
    setNotice(null);
    setPendingAction(null);
    setPending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const started = await readJson(res);
      if (generation.current !== mine) return;
      if (!res.ok || !started || typeof started.turnId !== "string") {
        setNotice(noticeFor(res.status, typeof started?.error === "string" ? started.error : undefined));
        return;
      }
      await pollReply(started.turnId, mine);
    } catch {
      if (generation.current === mine) setNotice(CHAT_DROPPED);
    } finally {
      if (generation.current === mine) setPending(false);
    }
  }

  async function pollReply(turnId: string, mine: number) {
    for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (generation.current !== mine) return;
      let res: Response;
      try {
        res = await fetch(`/api/chat/result?id=${encodeURIComponent(turnId)}`);
      } catch {
        setNotice(CHAT_DROPPED);
        return;
      }
      const body = await readJson(res);
      if (generation.current !== mine) return;
      if (!body) {
        setNotice(CHAT_UNAVAILABLE);
        return;
      }
      if (body.status === "pending") continue;
      if (body.status === "ready" && typeof body.reply === "string" && body.reply) {
        const action = body.pendingAction;
        if (typeof action?.actionId === "string" && typeof action.summary === "string") {
          setPendingAction({ actionId: action.actionId, summary: action.summary });
        }
        setTurns((current) => [...current, { role: "assistant" as const, content: body.reply as string }].slice(-6));
        return;
      }
      if (body.status === "error") {
        const status = typeof body.httpStatus === "number" ? body.httpStatus : res.status;
        setNotice(noticeFor(status, typeof body.error === "string" ? body.error : undefined));
        return;
      }
      setNotice(noticeFor(res.status, typeof body.error === "string" ? body.error : undefined));
      return;
    }
    setNotice(CHAT_UNAVAILABLE);
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
        setTurns((current) => [...current, { role: "assistant" as const, content: body.summary ?? "" }].slice(-6));
        return;
      }
      setNotice(noticeFor(res.status, body?.message || body?.error));
    } catch {
      setNotice(CHAT_DROPPED);
    } finally {
      setPending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <div className="fixed bottom-4 left-4 z-10">
      {open && (
        <section
          aria-label="Support chat"
          className="mb-2 flex w-[min(18rem,calc(100vw-2rem))] flex-col rounded-lg border border-stone-300 bg-white text-stone-900 shadow-xl"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-stone-200 pl-3 pr-1">
            <h2 className="text-sm font-semibold">Support</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close support chat"
              className="inline-flex h-11 w-11 items-center justify-center rounded text-stone-500 hover:bg-stone-100 hover:text-stone-900"
            >
              ✕
            </button>
          </div>
          <div className="max-h-[min(15rem,calc(100dvh-12rem))] space-y-2 overflow-y-auto px-3 py-3" aria-live="polite">
            {turns.length === 0 && !notice && (
              <p className="text-sm text-stone-500">Ask a question about the shop.</p>
            )}
            {turns.map((turn, index) => (
              <p
                key={index}
                className={`whitespace-pre-wrap break-words text-sm ${
                  turn.role === "user" ? "text-stone-900" : "text-stone-700"
                }`}
              >
                {turn.content}
              </p>
            ))}
            {notice && <p className="whitespace-pre-wrap break-words text-sm text-stone-700">{notice}</p>}
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
            {"Don't share personal info. Chats are processed by Cursor's agent service."}
          </p>
          <form onSubmit={send} className="flex shrink-0 items-end gap-2 p-2">
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
