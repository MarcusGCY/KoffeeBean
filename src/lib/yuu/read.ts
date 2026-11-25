import { biDbConfigured } from "@/lib/bi-db";
import { biHashConfigured } from "@/lib/bi-hash";
import { authMemberId, readYuuPanel } from "./db";
import { findPersona, YUU_PERSONAS } from "./personas";
import { tierForPoints } from "./tier";
import type { StorefrontYuu, YuuPanel, YuuPersonaChoice } from "./types";

function choice(id: string, displayName: string, points: number): YuuPersonaChoice {
  return { id, displayName, points, tier: tierForPoints(points) };
}

/** Personas for the storefront dropdown. Points come from Neon when it is configured. */
export async function loadStorefrontYuu(memberKey: string | null): Promise<StorefrontYuu> {
  const fallback = YUU_PERSONAS.map((persona) => choice(persona.id, persona.displayName, 0));
  if (!biDbConfigured()) return { personas: fallback, signedInMember: null };
  try {
    const panel = await readYuuPanel();
    const personas = panel.members
      .filter((member) => findPersona(member.id))
      .map((member) => choice(member.id, member.displayName, member.points));
    let signedInMember: YuuPersonaChoice | null = null;
    if (memberKey && biHashConfigured()) {
      const id = authMemberId(memberKey);
      const found = panel.members.find((member) => member.id === id);
      if (found) signedInMember = choice(found.id, found.displayName, found.points);
    }
    return {
      personas: personas.length > 0 ? personas : fallback,
      signedInMember,
    };
  } catch (error) {
    console.error("[yuu] storefront read failed", error instanceof Error ? error.name : "unknown");
    return { personas: fallback, signedInMember: null };
  }
}

/** Ops panel. Null when Neon is not configured, so the page does not call out. */
export async function loadYuuPanel(): Promise<YuuPanel | null> {
  if (!biDbConfigured()) return null;
  try {
    return await readYuuPanel();
  } catch (error) {
    console.error("[yuu] panel read failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
}
