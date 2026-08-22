import { afterEach, describe, expect, it, vi } from "vitest";

const originalVersion = process.env.NEXT_PUBLIC_OFFICECHAT_VERSION;

afterEach(() => {
  if (originalVersion === undefined) {
    delete process.env.NEXT_PUBLIC_OFFICECHAT_VERSION;
  } else {
    process.env.NEXT_PUBLIC_OFFICECHAT_VERSION = originalVersion;
  }
  vi.resetModules();
});

describe("release version metadata", () => {
  it("uses a non-release development marker when metadata is absent", async () => {
    delete process.env.NEXT_PUBLIC_OFFICECHAT_VERSION;
    vi.resetModules();

    const { officeChatBrand } = await import("../lib/brand");
    const { GET } = await import("../app/api/health/route");
    const response = await GET();

    expect(officeChatBrand.version).toBe("development");
    expect(await response.json()).toMatchObject({ version: "development" });
    expect(JSON.stringify(officeChatBrand)).not.toContain("0.1.0-rc2");
  });

  it("uses the exact version injected by a tagged release build", async () => {
    process.env.NEXT_PUBLIC_OFFICECHAT_VERSION = "0.1.0-test-release";
    vi.resetModules();

    const { officeChatBrand } = await import("../lib/brand");
    const { GET } = await import("../app/api/health/route");
    const response = await GET();

    expect(officeChatBrand.version).toBe("0.1.0-test-release");
    expect(await response.json()).toMatchObject({ version: "0.1.0-test-release" });
  });

  it("treats blank version metadata as a non-release source build", async () => {
    process.env.NEXT_PUBLIC_OFFICECHAT_VERSION = "   ";
    vi.resetModules();

    const { officeChatBrand } = await import("../lib/brand");
    const { GET } = await import("../app/api/health/route");
    const response = await GET();

    expect(officeChatBrand.version).toBe("development");
    expect(await response.json()).toMatchObject({ version: "development" });
  });
});
