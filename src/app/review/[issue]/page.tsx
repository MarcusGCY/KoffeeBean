import { Suspense } from "react";
import { reviewLinks } from "@/lib/approval";
import { getIssue } from "@/lib/github";

// Fallback human-review page for when the Grok bot is unavailable (demo safety net).
async function Review({ params }: { params: Promise<{ issue: string }> }) {
  const n = Number((await params).issue);
  const i = await getIssue(n);
  const links = reviewLinks(n);
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold">Review issue #{n}</h1>
      <h2 className="mt-2 text-lg">{i.title}</h2>
      <pre className="mt-4 whitespace-pre-wrap rounded bg-stone-100 p-4 text-sm">{i.body}</pre>
      <div className="mt-6 flex gap-3">
        <a href={links.approve} className="rounded bg-green-700 px-4 py-2 text-white">Approve &amp; fix</a>
        <a href={links.reject} className="rounded bg-red-700 px-4 py-2 text-white">Reject</a>
      </div>
    </main>
  );
}

export default function ReviewPage(props: { params: Promise<{ issue: string }> }) {
  return (
    <Suspense fallback={<p className="p-8">Loading…</p>}>
      <Review {...props} />
    </Suspense>
  );
}
