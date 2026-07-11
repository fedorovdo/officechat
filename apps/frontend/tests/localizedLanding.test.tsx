import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ACCESS_TOKEN_KEY, resetAuthenticationGuard, storeAccessToken } from "../lib/session";
import LocalePage from "../app/[locale]/page";
import { getLocalizedLandingTarget, LocaleLandingRedirect } from "../components/LocaleLandingRedirect";

const routerReplace = vi.fn();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ replace: routerReplace })
}));

function tokenWithExpiration(expirationSeconds: number) {
  const payload = btoa(JSON.stringify({ exp: expirationSeconds }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

function validToken() {
  return tokenWithExpiration(Math.floor(Date.now() / 1000) + 3600);
}

describe("localized landing route", () => {
  beforeEach(() => {
    routerReplace.mockClear();
    resetAuthenticationGuard();
  });

  it("/ru chooses the Russian app when a valid token exists", () => {
    storeAccessToken(validToken());
    expect(getLocalizedLandingTarget("ru")).toBe("/ru/app");
  });

  it("/en chooses the English app when a valid token exists", () => {
    storeAccessToken(validToken());
    expect(getLocalizedLandingTarget("en")).toBe("/en/app");
  });

  it("/ru chooses the Russian login flow when no token exists", () => {
    expect(getLocalizedLandingTarget("ru")).toBe("/ru/login");
  });

  it("/en chooses the English login flow when no token exists", () => {
    expect(getLocalizedLandingTarget("en")).toBe("/en/login");
  });

  it("expired token chooses login and clears the stored token", () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, tokenWithExpiration(1));
    expect(getLocalizedLandingTarget("ru")).toBe("/ru/login");
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
  });

  it("uses replace navigation for the localized landing redirect", async () => {
    render(<LocaleLandingRedirect locale="ru" />);
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/ru/login"));
  });

  it("does not call notFound for supported ru and en locales", async () => {
    await expect(LocalePage({ params: Promise.resolve({ locale: "ru" }) })).resolves.toBeTruthy();
    await expect(LocalePage({ params: Promise.resolve({ locale: "en" }) })).resolves.toBeTruthy();
  });

  it("invalid locale remains 404", async () => {
    await expect(LocalePage({ params: Promise.resolve({ locale: "de" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
