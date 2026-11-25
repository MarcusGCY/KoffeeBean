import { connection } from "next/server";
import { loadScenario } from "@/lib/demo/scenario";
import { requirePresenterPage } from "@/lib/demo/guard";
import { getDemoState, MAX_STAGE } from "@/lib/demo/state";

export const instant = false;

export const metadata = {
  title: "Pelita demo track",
  robots: { index: false, follow: false },
};

export default async function PelitaDemoPage() {
  await connection();
  await requirePresenterPage();
  const scenario = loadScenario();

  let stage: number | undefined;
  try {
    stage = (await getDemoState()).stage;
  } catch {
    stage = undefined;
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-10">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-extrabold">Pelita demo track ready</h1>
        <span className="rounded-lg border-2 border-dashed border-black px-3 py-0.5 text-lg font-extrabold">
          {scenario.demoTag}
        </span>
      </div>
      <p className="text-lg">
        {scenario.brand.name}.{" "}
        {stage === undefined
          ? "State store unavailable."
          : `Current stage: ${stage} of ${MAX_STAGE}.`}
      </p>
    </main>
  );
}
