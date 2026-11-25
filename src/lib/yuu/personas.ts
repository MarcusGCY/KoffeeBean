/** Seeded yuu (simulated) shoppers. Ids match db/migrations/0004_yuu_loyalty.sql. */

export type YuuPersona = { id: string; displayName: string };

export const YUU_PERSONAS: readonly YuuPersona[] = [
  { id: "sim-aisha-rahman", displayName: "Aisha Rahman (simulated)" },
  { id: "sim-benjamin-tan", displayName: "Benjamin Tan (simulated)" },
  { id: "sim-cheryl-lim", displayName: "Cheryl Lim (simulated)" },
  { id: "sim-danial-wong", displayName: "Danial Wong (simulated)" },
  { id: "sim-eileen-koh", displayName: "Eileen Koh (simulated)" },
  { id: "sim-farhan-ahmad", displayName: "Farhan bin Ahmad (simulated)" },
  { id: "sim-grace-ng", displayName: "Grace Ng (simulated)" },
  { id: "sim-harpreet-singh", displayName: "Harpreet Singh (simulated)" },
];

const BY_ID = new Map(YUU_PERSONAS.map((persona) => [persona.id, persona]));

export function findPersona(id: string): YuuPersona | undefined {
  return BY_ID.get(id);
}

/** Stable hash input for a persona. Not an Auth0 sub, and not shown to shoppers. */
export function personaHashKey(id: string): string {
  return `yuu:${id}`;
}

/** Display name for a signed-in shopper. The email is never used. */
export function simulatedDisplayName(name: string | undefined): string {
  const cleaned = (name ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60);
  const base = cleaned || "Signed-in member";
  return base.toLowerCase().includes("(simulated)") ? base : `${base} (simulated)`;
}
