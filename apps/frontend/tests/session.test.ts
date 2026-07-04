import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentUser } from "../lib/api";
import {
  ACCESS_TOKEN_KEY,
  AUTHENTICATION_EXPIRED_EVENT,
  clearStoredAccessToken,
  expireAuthentication,
  getStoredAccessToken,
  logoutSession,
  resetAuthenticationGuard,
  storeAccessToken
} from "../lib/session";

function tokenWithExpiration(expirationSeconds: number) {
  const payload = btoa(JSON.stringify({ exp: expirationSeconds }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

const validToken = () => tokenWithExpiration(Math.floor(Date.now() / 1000) + 3600);

describe("centralized session handling", () => {
  beforeEach(() => {
    resetAuthenticationGuard();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("stores and reads officechat.access_token", () => {
    storeAccessToken(validToken());
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeTruthy();
    expect(getStoredAccessToken()).toBe(localStorage.getItem(ACCESS_TOKEN_KEY));
  });

  it("removes only the access token and preserves preferences", () => {
    storeAccessToken(validToken());
    localStorage.setItem("officechat.theme", "dark");
    localStorage.setItem("officechat.user_settings", "preferences");
    clearStoredAccessToken();
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem("officechat.theme")).toBe("dark");
    expect(localStorage.getItem("officechat.user_settings")).toBe("preferences");
  });

  it("detects an expired JWT and clears it", () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, tokenWithExpiration(1));
    expect(getStoredAccessToken()).toBeNull();
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
  });

  it("handles malformed JWT safely", () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, "not-a-jwt");
    expect(() => getStoredAccessToken()).not.toThrow();
    expect(getStoredAccessToken()).toBeNull();
  });

  it("deduplicates simultaneous authentication failures", () => {
    storeAccessToken(validToken());
    const listener = vi.fn();
    window.addEventListener(AUTHENTICATION_EXPIRED_EVENT, listener);
    expireAuthentication("expired");
    expireAuthentication("expired");
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(AUTHENTICATION_EXPIRED_EVENT, listener);
  });

  it("keeps the token after a 403 response", async () => {
    const token = validToken();
    storeAccessToken(token);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ detail: "Denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    }));
    await expect(getCurrentUser(token)).rejects.toThrow("Denied");
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe(token);
  });

  it("keeps the token after a network failure", async () => {
    const token = validToken();
    storeAccessToken(token);
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(getCurrentUser(token)).rejects.toThrow("Server is unavailable");
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe(token);
  });

  it("logout clears the local session even when the backend fails", async () => {
    storeAccessToken(validToken());
    localStorage.setItem("officechat.theme", "dark");
    vi.mocked(fetch).mockRejectedValue(new TypeError("offline"));
    await logoutSession("ru", "http://localhost:8100");
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem("officechat.theme")).toBe("dark");
  });
});
