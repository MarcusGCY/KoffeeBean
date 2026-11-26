import { yuuBoughtLine } from "@/lib/yuu/types";

export type YuuBuyNote = { kind: "ok"; points: number } | { kind: "error"; text: string };

/** Inline result under the Buy with yuu button that was pressed. */
export function YuuBuyFeedback({ note }: { note: YuuBuyNote | null }) {
  if (!note) return null;
  if (note.kind === "ok") {
    return (
      <p role="status" data-yuu-bought className="mt-2 text-base font-bold text-primary-dark">
        {yuuBoughtLine(note.points)}
      </p>
    );
  }
  return (
    <p role="alert" data-yuu-error className="mt-2 text-base font-bold text-danger">
      {note.text}
    </p>
  );
}
