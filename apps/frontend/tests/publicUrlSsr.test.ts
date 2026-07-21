import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPublicUrl, getPublicOrigin } from "../lib/public-url";

describe("public URL helpers during SSR", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the configured frontend URL without accessing window", () => {
    vi.stubGlobal("window", undefined);
    vi.stubEnv("NEXT_PUBLIC_FRONTEND_URL", "https://officechat.adm.net/");
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "https://backend.example/");

    expect(getPublicOrigin()).toBe("https://officechat.adm.net");
    expect(buildPublicUrl("/docs")).toBe("https://officechat.adm.net/docs");
  });

  it("falls back to the configured backend URL", () => {
    vi.stubGlobal("window", undefined);
    vi.stubEnv("NEXT_PUBLIC_FRONTEND_URL", "");
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "https://officechat.adm.net/");

    expect(getPublicOrigin()).toBe("https://officechat.adm.net");
  });

  it("has a development fallback when no public URL is configured", () => {
    vi.stubGlobal("window", undefined);
    vi.stubEnv("NEXT_PUBLIC_FRONTEND_URL", "");
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "");

    expect(getPublicOrigin()).toBe("http://localhost:3100");
  });
});
