"use client";

import { useState } from "react";

type Turn = { role: "user" | "assistant"; content: string };

const UNAVAILABLE =
  "Support chat is unavailable. Please use the 'Report a problem' button at the bottom right.";

function noticeFor(status: number, error: string | undefined): string {
  if (status === 429 && error) return error;
  if (status === 503 || error === "unavailable" || status === 502 || status >= 500) return UNAVAILABLE;
  if (error) return error;
  return UNAVAILABLE;
}

export function SupportChat() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || pending) return;

    const next = [...turns, { role: "user" as const, content }].slice(-6);
    setTurns(next);
    setDraft("");
    setNotice(null);
    setPending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; reply?: string } | null;
      if (res.ok && typeof body?.reply === "string" && body.reply) {
        const reply = body.reply;
        setTurns((current) => [...current, { role: "assistant" as const, content: reply }].slice(-6));
        return;
      }
      setNotice(noticeFor(res.status, body?.error));
    } catch {
      setNotice(UNAVAILABLE);
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
          </div>
          <p className="border-t border-stone-200 px-3 pt-2 text-xs text-stone-500">
            {"Don't share personal info. Messages are processed by OpenAI."}
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
