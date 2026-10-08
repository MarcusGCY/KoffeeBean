import { afterEach, describe, expect, it } from "vitest";
import { appOrigin, auth0BaseUrl } from "@/lib/origin";

const KEYS = ["APP_URL", "APP_BASE_URL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL"] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

function remember() {
  for (const key of KEYS) saved[key] = process.env[key];
}

function restore() {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function clear() {
  for (const key of KEYS) delete process.env[key];
}

describe("app origin", () => {
  afterEach(() => {
    restore();
  });

  it("prefers APP_URL for links and APP_BASE_URL for Auth0 when both are set", () => {
    remember();
    clear();
    process.env.APP_URL = "https://shop.example/";
    process.env.APP_BASE_URL = "https://auth.example";
    expect(appOrigin()).toBe("https://shop.example");
    expect(auth0BaseUrl()).toBe("https://auth.example");
  });

  it("falls back to the preview deployment host when the app URLs are unset", () => {
    remember();
    clear();
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "beanbox-git-demo.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "beanbox.vercel.app";
    expect(appOrigin()).toBe("https://beanbox-git-demo.vercel.app");
    expect(auth0BaseUrl()).toBe("https://beanbox-git-demo.vercel.app");
  });

  it("falls back to the production host, then VERCEL_URL", () => {
    remember();
    clear();
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "https://beanbox.vercel.app/";
    process.env.VERCEL_URL = "beanbox-abc.vercel.app";
    expect(appOrigin()).toBe("https://beanbox.vercel.app");
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    expect(appOrigin()).toBe("https://beanbox-abc.vercel.app");
  });

  it("uses APP_URL on a preview when it is set", () => {
    remember();
    clear();
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "beanbox-git-demo.vercel.app";
    process.env.APP_URL = "https://shop.example";
    expect(appOrigin()).toBe("https://shop.example");
  });

  it("throws when no origin can be resolved", () => {
    remember();
    clear();
    expect(() => appOrigin()).toThrow(/APP_URL/);
    expect(auth0BaseUrl()).toBeUndefined();
  });
});
