import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPublicUrl,
  buildWebSocketUrl,
  getApiBaseUrl,
  getApiDocsHref,
  getIncomingBotWebhookUrl,
  getPublicOrigin
} from "../lib/public-url";

describe("public URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses a relative docs URL on the current HTTPS origin", () => {
    expect(getApiDocsHref()).toBe("/docs");
    expect(new URL(getApiDocsHref(), "https://officechat.example.local").href).toBe(
      "https://officechat.example.local/docs"
    );
  });

  it("builds the bot webhook URL from an HTTPS production origin", () => {
    expect(getIncomingBotWebhookUrl("bot/token +", "https://officechat.example.local")).toBe(
      "https://officechat.example.local/api/bots/incoming/bot%2Ftoken%20%2B"
    );
  });

  it("removes trailing and duplicate boundary slashes", () => {
    expect(buildPublicUrl("//docs", "https://officechat.example.local///")).toBe(
      "https://officechat.example.local/docs"
    );
  });

  it("prefers the browser runtime origin", () => {
    vi.stubEnv("NEXT_PUBLIC_FRONTEND_URL", "https://configured.example");

    expect(getPublicOrigin()).toBe(window.location.origin);
    expect(getApiBaseUrl()).toBe("");
  });

  it("converts an HTTPS origin to WSS", () => {
    expect(buildWebSocketUrl("/api/ws/me", "secret token", "https://chat.example.local")).toBe(
      "wss://chat.example.local/api/ws/me?token=secret+token"
    );
  });

  it("converts an HTTP origin to WS", () => {
    expect(buildWebSocketUrl("/api/ws/me", "token", "http://chat.example.local/")).toBe(
      "ws://chat.example.local/api/ws/me?token=token"
    );
  });
});
