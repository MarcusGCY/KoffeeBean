"use client";

import { useState } from "react";

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (res.ok) { setState("sent"); setMessage(""); } else setState("error");
  }

  return (
    <div className="fixed bottom-5 right-5 z-10">
      {open ? (
        <form onSubmit={submit} className="w-80 rounded-lg border border-stone-300 bg-white p-4 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Report a problem</h2>
            <button type="button" onClick={() => { setOpen(false); setState("idle"); }} aria-label="Close" className="text-stone-500">✕</button>
          </div>
          {state === "sent" ? (
            <p className="text-sm text-green-700">Thanks! We are looking into it.</p>
          ) : (
            <>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                required
                placeholder="What went wrong?"
                className="w-full rounded border border-stone-300 p-2 text-sm"
              />
              {state === "error" && <p className="mt-1 text-xs text-red-600">Something went wrong. Try again.</p>}
              <button disabled={state === "sending"} className="mt-2 w-full rounded bg-amber-700 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                {state === "sending" ? "Sending…" : "Send feedback"}
              </button>
            </>
          )}
        </form>
      ) : (
        <button onClick={() => setOpen(true)} className="rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-white shadow-lg">
          Report a problem
        </button>
      )}
    </div>
  );
}
