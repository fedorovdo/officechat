import { beforeEach, describe, expect, it, vi } from "vitest";

import { connectResilientWebSocket } from "../lib/resilientWebSocket";
import { AUTHENTICATION_EXPIRED_EVENT, ACCESS_TOKEN_KEY, resetAuthenticationGuard } from "../lib/session";
import { TestWebSocket } from "./setup";

function connect(overrides: Partial<Parameters<typeof connectResilientWebSocket>[0]> = {}) {
  return connectResilientWebSocket({
    getUrl: () => "ws://localhost:8100/api/ws/me?token=secret-token",
    onMessage: vi.fn(),
    onStatusChange: vi.fn(),
    ...overrides
  });
}

describe("resilient WebSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    resetAuthenticationGuard();
  });

  it("opens a connection with the requested URL without logging its token", () => {
    const cleanup = connect();
    expect(TestWebSocket.instances).toHaveLength(1);
    expect(TestWebSocket.instances[0].url).toContain("/api/ws/me?token=secret-token");
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    cleanup();
  });

  it("schedules a bounded reconnect after a normal disconnect", () => {
    const status = vi.fn();
    const cleanup = connect({ onStatusChange: status });
    TestWebSocket.instances[0].close(1006);
    expect(status).toHaveBeenLastCalledWith("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(TestWebSocket.instances).toHaveLength(2);
    cleanup();
  });

  it("increases reconnect delay across failed attempts", () => {
    const cleanup = connect();
    TestWebSocket.instances[0].close(1006);
    vi.advanceTimersByTime(1000);
    TestWebSocket.instances[1].close(1006);
    vi.advanceTimersByTime(1999);
    expect(TestWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(TestWebSocket.instances).toHaveLength(3);
    cleanup();
  });

  it("resets reconnect delay after a successful connection", () => {
    const cleanup = connect();
    TestWebSocket.instances[0].close(1006);
    vi.advanceTimersByTime(1000);
    TestWebSocket.instances[1].open();
    TestWebSocket.instances[1].close(1006);
    vi.advanceTimersByTime(999);
    expect(TestWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(TestWebSocket.instances).toHaveLength(3);
    cleanup();
  });

  it("4401 expires authentication", () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, "token");
    const cleanup = connect();
    TestWebSocket.instances[0].close(4401);
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    vi.advanceTimersByTime(30000);
    expect(TestWebSocket.instances).toHaveLength(1);
    cleanup();
  });

  it("4403 reports forbidden without logging out", () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, "token");
    const onForbidden = vi.fn();
    const cleanup = connect({ onForbidden });
    TestWebSocket.instances[0].close(4403);
    expect(onForbidden).toHaveBeenCalledOnce();
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("token");
    vi.advanceTimersByTime(30000);
    expect(TestWebSocket.instances).toHaveLength(1);
    cleanup();
  });

  it("authentication expiry and cleanup cancel pending reconnect", () => {
    const cleanup = connect();
    TestWebSocket.instances[0].close(1006);
    expect(vi.getTimerCount()).toBe(1);
    window.dispatchEvent(new CustomEvent(AUTHENTICATION_EXPIRED_EVENT, { detail: { reason: "logout" } }));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30000);
    expect(TestWebSocket.instances).toHaveLength(1);
    cleanup();
  });

  it("component cleanup prevents reconnect", () => {
    const cleanup = connect();
    TestWebSocket.instances[0].close(1006);
    cleanup();
    vi.advanceTimersByTime(30000);
    expect(TestWebSocket.instances).toHaveLength(1);
  });

  it("keeps only one reconnect timer", () => {
    const cleanup = connect();
    TestWebSocket.instances[0].close(1006);
    TestWebSocket.instances[0].onclose?.(new CloseEvent("close", { code: 1006 }));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(TestWebSocket.instances).toHaveLength(2);
    cleanup();
  });
});
