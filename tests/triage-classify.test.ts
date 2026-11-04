import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/triage/classify/route";
import { XAI_CHAT_URL } from "@/lib/xai-chat";

const SECRET = "triage-secret";
const KEY = "xai-test-key-do-not-leak";
const EMAIL = "shopper@example.com";
const CARD = "4242424242424242";

const valid = {
  category: "cart",
  severity: "S2",
  summary: "Add to cart does nothing for one bag.",
  steps_to_reproduce: ["Open the shop", "Add the tote"],
  suspected_area: "src/lib/cart.ts",
  duplicate_of: null,
  duplicate_confidence: 0.4,
  screenshot_findings: null,
  pii_found: [],
  redacted_text: "Add to cart does nothing for the tote.",
  confidence: 0.8,
  needs_human: false,
};

function completion(content: string) {
  return Response.json({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 40 },
  });
}

function post(body: unknown, authorization = `Bearer ${SECRET}`) {
  return POST(
    new Request("http://localhost/api/triage/classify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/triage/classify", () => {
  const seen: { url: string; body: string | null; auth: string | null }[] = [];

  beforeEach(() => {
    process.env.TRIAGE_API_SECRET = SECRET;
    process.env.XAI_API_KEY = KEY;
    delete process.env.TRIAGE_GROK_MODEL;
    seen.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: String(input),
          body: init?.body == null ? null : String(init.body),
          auth: headers.get("authorization"),
        });
        return completion(JSON.stringify(valid));
      }),
    );
  });

  afterEach(() => {
    delete process.env.TRIAGE_API_SECRET;
    delete process.env.XAI_API_KEY;
    delete process.env.TRIAGE_GROK_MODEL;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns schema-valid output and logs tokens without the key or the report", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await post({
      text: "Add to cart does nothing for the tote.",
      candidates: [{ number: 12, title: "Tote add", body: "Nothing happens." }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject(valid);
    const sent = JSON.parse(seen[0]?.body ?? "{}") as {
      model?: string;
      tools?: unknown;
      response_format?: { type?: string };
    };
    expect(seen[0]?.url).toBe(XAI_CHAT_URL);
    expect(seen[0]?.auth).toBe(`Bearer ${KEY}`);
    expect(sent.model).toBe("grok-4.20-0309-non-reasoning");
    expect(sent.tools).toBeUndefined();
    expect(sent.response_format?.type).toBe("json_schema");
    expect(seen[0]?.body).toContain("untrusted");
    expect(seen[0]?.body).toContain("<<<FEEDBACK>>>");
    const line = log.mock.calls.flat().map(String).join("\n");
    expect(line).toContain("[triage-classify] ok model=grok-4.20-0309-non-reasoning");
    expect(line).toContain("category=cart");
    expect(line).toContain("severity=S2");
    expect(line).toContain("in=100");
    expect(line).toContain("out=40");
    expect(line).toContain("cost=0.000225");
    expect(line).not.toContain(KEY);
    expect(line).not.toContain("tote");
    log.mockRestore();
  });

  it("retries once after invalid output and returns needs_human when both attempts fail", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n === 1) return completion("not json");
        return completion(JSON.stringify(valid));
      }),
    );
    const retried = await post({ text: "The mug photo is missing." });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ category: "cart", needs_human: false });
    expect(n).toBe(2);

    n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        return completion("still not json");
      }),
    );
    const failed = await post({ text: "The mug photo is missing." });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({
      category: "other",
      severity: "S4",
      needs_human: true,
      duplicate_of: null,
      confidence: 0,
    });
    expect(n).toBe(2);
  });

  it("redacts PII before the xAI call and again on the model output", async () => {
    const echoed = {
      ...valid,
      summary: `Email ${EMAIL} about card ${CARD}`,
      steps_to_reproduce: ["Call +65 9123 4567"],
      redacted_text: `See ${EMAIL}`,
      pii_found: [EMAIL],
    };
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(_input), body: init?.body == null ? null : String(init.body), auth: null });
      return completion(JSON.stringify(echoed));
    }));
    const text = `Write ${EMAIL} or call 91234567. Card ${CARD}. Ship to 10 Orchard Road, Singapore 238801.`;
    const res = await post({ text });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: string; steps_to_reproduce: string[]; redacted_text: string; pii_found: string[] };
    expect(seen[0]?.body).not.toContain(EMAIL);
    expect(seen[0]?.body).not.toContain(CARD);
    expect(seen[0]?.body).not.toContain("91234567");
    expect(seen[0]?.body).toContain("[redacted-email]");
    expect(body.summary).not.toContain(EMAIL);
    expect(body.summary).not.toContain(CARD);
    expect(body.summary).toContain("[redacted-email]");
    expect(body.steps_to_reproduce.join(" ")).not.toContain("9123");
    expect(body.redacted_text).not.toContain(EMAIL);
    expect(body.pii_found).toEqual(expect.arrayContaining(["email", "phone", "card", "address", "postal"]));
    expect(body.pii_found.join(" ")).not.toContain(EMAIL);
  });

  it("rejects a bad bearer and does not call xAI", async () => {
    const mismatch = await post({ text: "Hello" }, "Bearer wrong-secret");
    expect(mismatch.status).toBe(401);
    delete process.env.TRIAGE_API_SECRET;
    const missing = await post({ text: "Hello" });
    expect(missing.status).toBe(503);
    delete process.env.XAI_API_KEY;
    process.env.TRIAGE_API_SECRET = SECRET;
    const noKey = await post({ text: "Hello" });
    expect(noKey.status).toBe(503);
    expect(await noKey.json()).toEqual({ error: "XAI_API_KEY is not set" });
    expect(seen).toHaveLength(0);
  });

  it("sends an https screenshot as an image_url part", async () => {
    const shot = "https://cdn.example.com/shot.png";
    const res = await post({ text: "The photo is broken.", screenshot: shot });
    expect(res.status).toBe(200);
    const sent = JSON.parse(seen[0]?.body ?? "{}") as {
      messages?: { role: string; content?: { type?: string; image_url?: { url?: string }; text?: string }[] }[];
    };
    const parts = sent.messages?.find((message) => message.role === "user")?.content ?? [];
    const image = parts.find((part) => part.type === "image_url");
    expect(image?.image_url?.url).toBe(shot);
    expect(JSON.stringify(parts)).toContain("<<<FEEDBACK>>>");
  });
});
