import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("can be imported without browser globals during SSR", async () => {
  vi.stubGlobal("window", undefined);
  vi.resetModules();

  const module = await import("../lib/client-id");

  expect(typeof module.createClientId).toBe("function");
  expect(() => module.createClientId()).not.toThrow();
});
