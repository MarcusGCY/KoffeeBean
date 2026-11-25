import type { Scenario } from "./scenario";
import { commitOpeningRows, type DemoAuditRow, type DemoState } from "./state";

/** The fixture's two opening agent rows: the gap the agent spotted and the listing it proposed. Both carry the proposal id. */
export function openingFixtureRows(scenario: Scenario): Scenario["audit"] {
  return scenario.audit.filter((row) => row.actorKind === "agent" && row.ref === scenario.gap.id);
}

/** True when `row` is one of the opening rows, whatever its timestamp. */
function isOpening(scenario: Scenario, row: DemoAuditRow): boolean {
  return openingFixtureRows(scenario).some((f) => f.actorKind === row.actorKind && f.ref === row.ref && f.action === row.action);
}

/** The real "Spotted gap" row: the start of the detection-to-live time. Null when it was never written. */
export function findDetectionRow(scenario: Scenario, state: Pick<DemoState, "audit">): DemoAuditRow | null {
  const first = openingFixtureRows(scenario)[0];
  if (!first) return null;
  return state.audit.find((row) => isOpening(scenario, row) && row.action === first.action) ?? null;
}

/**
 * Writes the two opening agent rows (spotted the gap, proposed the listing) the first
 * time screen 01 loads after a reset. They go in once: a load that finds them, a load
 * that finds any other audit row, and a load that loses a race for the guard all write
 * nothing, so reloads and simultaneous loads cannot duplicate them. Returns whether this
 * call wrote them.
 */
export async function ensureOpeningRows(scenario: Scenario, state: Pick<DemoState, "audit">, now: Date = new Date()): Promise<boolean> {
  if (state.audit.length > 0) return false;
  const at = now.toISOString();
  const rows = openingFixtureRows(scenario).map((row): DemoAuditRow => ({ ...row, at }));
  return commitOpeningRows(rows);
}
