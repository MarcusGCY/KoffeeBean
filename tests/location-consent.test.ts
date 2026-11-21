import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PUT } from "@/app/api/account/location/route";
import { normalizeLocation } from "@/lib/location-consent";
import { LOCATION_PURPOSE, districtOf, parsePostcode } from "@/lib/location-text";
import { getShopper } from "@/lib/shopper";

const SUB = "auth0|shopper";
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown> }));

vi.mock("@/lib/auth0-mgmt", () => ({
  mgmtConfigured: () => true,
  getAppMetadata: async () => structuredClone(db.meta),
  patchAppMetadata: async (_userId: string, patch: Record<string, unknown>) => {
    const next = { ...db.meta };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    db.meta = next;
    return structuredClone(db.meta);
  },
}));
vi.mock("@/lib/shopper", () => ({ getShopper: vi.fn(), reporterBlock: () => "" }));

function request(method: string, body?: unknown, headers: Record<string, string> = { origin: "http://localhost:3000" }) {
  return new Request("http://localhost/api/account/location", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  db.meta = {};
  process.env.APP_BASE_URL = "http://localhost:3000";
  vi.mocked(getShopper).mockResolvedValue({ id: SUB, email: "a@example.com", name: "Ada" });
});

afterEach(() => {
  delete process.env.APP_BASE_URL;
});

describe("postcode parsing", () => {
  it("accepts exactly six digits and takes the first two as the district", () => {
    expect(parsePostcode(" 238823 ")).toBe("238823");
    expect(districtOf("238823")).toBe("23");
    for (const bad of ["23882", "2388234", "23 882", "abcdef", "23882a", "", null, 238823]) {
      expect(parsePostcode(bad)).toBeNull();
    }
  });

  it("derives the district from the postcode and ignores a stored one", () => {
    const row = { postcode: "680123", district: "99", consentAt: "2026-11-01T00:00:00.000Z", purpose: LOCATION_PURPOSE };
    expect(normalizeLocation(row)?.district).toBe("68");
    expect(normalizeLocation({ ...row, postcode: "12" })).toBeNull();
    expect(normalizeLocation({ ...row, consentAt: "never" })).toBeNull();
    expect(normalizeLocation({ ...row, purpose: "" })).toBeNull();
    expect(normalizeLocation([row])).toBeNull();
  });
});

describe("/api/account/location", () => {
  it("is optional: a shopper who never opted in has no location", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ location: null });
    expect(db.meta.location).toBeUndefined();
  });

  it("stores postcode, district, consent time and purpose only after an explicit opt-in", async () => {
    const res = await PUT(request("PUT", { postcode: "238823", consent: true }));
    expect(res.status).toBe(200);
    const stored = db.meta.location as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["consentAt", "district", "postcode", "purpose"]);
    expect(stored).toMatchObject({ postcode: "238823", district: "23", purpose: LOCATION_PURPOSE });
    expect(Number.isNaN(Date.parse(String(stored.consentAt)))).toBe(false);
    expect(((await (await GET()).json()) as { location: { district: string } }).location.district).toBe("23");
  });

  it("does not treat a postcode as consent", async () => {
    for (const body of [
      { postcode: "238823" },
      { postcode: "238823", consent: false },
      { postcode: "238823", consent: "true" },
    ]) {
      expect((await PUT(request("PUT", body))).status).toBe(400);
    }
    expect(db.meta.location).toBeUndefined();
  });

  it("rejects anything that is not a six-digit postcode and unknown keys", async () => {
    for (const body of [
      { postcode: "12345", consent: true },
      { postcode: "1234567", consent: true },
      { postcode: "12 345", consent: true },
      { postcode: "238823", consent: true, district: "99" },
    ]) {
      expect((await PUT(request("PUT", body))).status).toBe(400);
    }
    expect(db.meta.location).toBeUndefined();
  });

  it("withdraws consent and clears the stored postcode", async () => {
    await PUT(request("PUT", { postcode: "238823", consent: true }));
    const res = await DELETE(request("DELETE", {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ location: null });
    expect(db.meta.location).toBeUndefined();
    expect(JSON.stringify(db.meta.audit)).not.toContain("238823");
  });

  it("audits consent and withdrawal without writing the postcode", async () => {
    await PUT(request("PUT", { postcode: "238823", consent: true }));
    await DELETE(request("DELETE", {}));
    const tools = (db.meta.audit as { tool: string }[]).map((row) => row.tool);
    expect(tools).toEqual(["location.consent", "location.withdraw"]);
    expect(JSON.stringify(db.meta.audit)).not.toMatch(/\d{6}/);
  });

  it("requires a signed-in shopper and a same-origin JSON write", async () => {
    expect((await PUT(request("PUT", { postcode: "238823", consent: true }, { origin: "http://evil.example" }))).status).toBe(403);
    expect((await DELETE(request("DELETE", {}, {}))).status).toBe(403);
    vi.mocked(getShopper).mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await PUT(request("PUT", { postcode: "238823", consent: true }))).status).toBe(401);
    expect((await DELETE(request("DELETE", {}))).status).toBe(401);
    expect(db.meta.location).toBeUndefined();
  });

  it("only ever touches the signed-in shopper's own metadata", async () => {
    const body = { postcode: "238823", consent: true, userId: "auth0|someone-else" };
    expect((await PUT(request("PUT", body))).status).toBe(400);
  });
});
