import { afterEach, describe, expect, it, vi } from "vitest";

import { createClientId } from "../lib/client-id";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createClientId", () => {
  it("uses native randomUUID when available", () => {
    const nativeId = "123e4567-e89b-42d3-a456-426614174000";
    const randomUUID = vi.fn(() => nativeId);
    const getRandomValues = vi.fn();
    vi.stubGlobal("crypto", { getRandomValues, randomUUID });

    expect(createClientId()).toBe(nativeId);
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("creates a UUID v4 with getRandomValues when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.forEach((_, index) => { bytes[index] = index; });
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    const id = createClientId();

    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(id).toMatch(UUID_V4_PATTERN);
    expect(id).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("creates unique UUID-shaped IDs without Web Crypto", () => {
    vi.stubGlobal("crypto", undefined);

    const ids = new Set(Array.from({ length: 100 }, () => createClientId()));

    expect(ids.size).toBe(100);
    ids.forEach((id) => expect(id).toMatch(UUID_V4_PATTERN));
  });

  it("falls back when an exposed randomUUID method throws", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(7));
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => { throw new TypeError("Unavailable in this context"); }),
      getRandomValues
    });

    expect(createClientId()).toMatch(UUID_V4_PATTERN);
    expect(getRandomValues).toHaveBeenCalledOnce();
  });
});
