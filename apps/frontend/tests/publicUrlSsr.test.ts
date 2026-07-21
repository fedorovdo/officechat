import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPublicUrl, getApiBaseUrl, getPublicOrigin } from "../lib/public-url";

describe("public URL helpers during SSR", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the configured frontend URL without accessing window", () => {
    vi.stubGlobal("window", undefined);
    vi.stubEnv("NEXT_PUBLIC_FRONTEND_URL", "https://officechat.example.local/");
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "https://backend.example/");

    expect(getPublicOrigin()).toBe("https://officechat.example.local");
    expect(getApiBaseUrl()).toBe("https://backend.example");
    expect(buildPublicUrl("/docs")).toBe("https://officechat.example.local/docs");
  });

  it("falls back to the configured backend URL", () => {
    vi.stubGlobal("window", undefined);
    vi.stubEnv("NEXT_PUBLIC_FRONTEND_URL", "");
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "https://officechat.example.local/");

    expect(getPublicOrigin()).toBe("https://officechat.example.local");
  });

  it("uses relative same-origin URLs when no SSR origin is configured", () => {
    vi.stubGlobal("window", undefined);
    vi.stubEnv("NEXT_PUBLIC_FRONTEND_URL", "");
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "");

    expect(getPublicOrigin()).toBe("");
    expect(buildPublicUrl("/docs")).toBe("/docs");
  });
});
