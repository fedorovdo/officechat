import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPublicUrl,
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
    expect(new URL(getApiDocsHref(), "https://officechat.adm.net").href).toBe(
      "https://officechat.adm.net/docs"
    );
  });

  it("builds the bot webhook URL from an HTTPS production origin", () => {
    expect(getIncomingBotWebhookUrl("bot-token", "https://officechat.adm.net")).toBe(
      "https://officechat.adm.net/api/bots/incoming/bot-token"
    );
  });

  it("removes trailing and duplicate boundary slashes", () => {
    expect(buildPublicUrl("//docs", "https://officechat.adm.net///")).toBe(
      "https://officechat.adm.net/docs"
    );
  });

  it("prefers the browser runtime origin", () => {
    vi.stubEnv("NEXT_PUBLIC_FRONTEND_URL", "https://configured.example");

    expect(getPublicOrigin()).toBe(window.location.origin);
  });
});
