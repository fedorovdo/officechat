import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { clearAppBadge, updateAppBadge } from "../lib/appBadge";
import {
  notificationDedupeKey,
  shouldShowOpenAppNotification,
  showOpenAppNotification
} from "../lib/openAppNotification";
import { readWindowActivity, useWindowActivity } from "../lib/useWindowActivity";
import { useAppBadge } from "../lib/useAppBadge";

describe("window activity", () => {
  it("is active only while visible and focused", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
    expect(readWindowActivity().isActive).toBe(true);
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    expect(readWindowActivity().isActive).toBe(false);
  });

  it("tracks focus, blur and visibility changes with cleanup", () => {
    let focused = true;
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focused });
    const { result, unmount } = renderHook(() => useWindowActivity());
    expect(result.current.isActive).toBe(true);
    focused = false;
    act(() => window.dispatchEvent(new Event("blur")));
    expect(result.current.hasFocus).toBe(false);
    unmount();
  });
});

describe("PWA app badge", () => {
  it("sets and clears the authoritative unread count", async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadgeMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperties(navigator, {
      setAppBadge: { configurable: true, value: setAppBadge },
      clearAppBadge: { configurable: true, value: clearAppBadgeMock }
    });
    await expect(updateAppBadge(7)).resolves.toBe(true);
    await expect(clearAppBadge()).resolves.toBe(true);
    expect(setAppBadge).toHaveBeenCalledWith(7);
    expect(clearAppBadgeMock).toHaveBeenCalledTimes(1);
  });

  it("is harmless when the Badging API is unavailable", async () => {
    Object.defineProperties(navigator, {
      setAppBadge: { configurable: true, value: undefined },
      clearAppBadge: { configurable: true, value: undefined }
    });
    await expect(updateAppBadge(2)).resolves.toBe(false);
  });

  it("normalizes fractional, negative and NaN badge values", async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadgeMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperties(navigator, {
      setAppBadge: { configurable: true, value: setAppBadge },
      clearAppBadge: { configurable: true, value: clearAppBadgeMock }
    });
    await updateAppBadge(3.9);
    await updateAppBadge(-2);
    await updateAppBadge(Number.NaN);
    expect(setAppBadge).toHaveBeenCalledWith(3);
    expect(clearAppBadgeMock).toHaveBeenCalledTimes(2);
  });

  it("restores after login/reload and clears on logout", () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadgeMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperties(navigator, {
      setAppBadge: { configurable: true, value: setAppBadge },
      clearAppBadge: { configurable: true, value: clearAppBadgeMock }
    });
    const { rerender } = renderHook(
      ({ authenticated, total }) => useAppBadge(total, authenticated),
      { initialProps: { authenticated: null as boolean | null, total: 0 } }
    );
    rerender({ authenticated: true, total: 4 });
    rerender({ authenticated: true, total: 2 });
    rerender({ authenticated: false, total: 0 });
    expect(setAppBadge).toHaveBeenNthCalledWith(1, 4);
    expect(setAppBadge).toHaveBeenNthCalledWith(2, 2);
    expect(clearAppBadgeMock).toHaveBeenCalledTimes(1);
  });

  it("clears the app badge when an authenticated unread total becomes zero", () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadgeMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperties(navigator, {
      setAppBadge: { configurable: true, value: setAppBadge },
      clearAppBadge: { configurable: true, value: clearAppBadgeMock }
    });
    const { rerender } = renderHook(
      ({ total }) => useAppBadge(total, true),
      { initialProps: { total: 5 } }
    );
    rerender({ total: 0 });
    expect(setAppBadge).toHaveBeenCalledWith(5);
    expect(clearAppBadgeMock).toHaveBeenCalledTimes(1);
  });
});

describe("open app notifications", () => {
  const hidden = { visibilityState: "hidden", hidden: true, hasFocus: false, isActive: false } as const;
  const active = { visibilityState: "visible", hidden: false, hasFocus: true, isActive: true } as const;

  it("allows another user's message only while the app is inactive", () => {
    const base = { enabled: true, permission: "granted" as const, senderUserId: "other", currentUserId: "me", duplicate: false };
    expect(shouldShowOpenAppNotification({ ...base, activity: hidden })).toBeNull();
    expect(shouldShowOpenAppNotification({ ...base, activity: active })).toBe("tabActive");
    expect(shouldShowOpenAppNotification({ ...base, activity: hidden, senderUserId: "me" })).toBe("senderIsCurrentUser");
    expect(shouldShowOpenAppNotification({ ...base, activity: hidden, duplicate: true })).toBe("duplicate");
  });

  it("scopes duplicate keys by conversation type and id", () => {
    const base = { locale: "ru" as const, messageId: "same-id" };
    expect(notificationDedupeKey({ ...base, conversationType: "group", conversationId: "group-1" }))
      .not.toBe(notificationDedupeKey({ ...base, conversationType: "direct", conversationId: "direct-1" }));
  });

  it("uses an icon, dedupe tag and navigation data", () => {
    const close = vi.fn();
    const calls: Array<[string, NotificationOptions | undefined]> = [];
    class NotificationMock {
      onclick: null | (() => void) = null;
      close = close;

      constructor(title: string, options?: NotificationOptions) {
        calls.push([title, options]);
      }
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: NotificationMock });
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: NotificationMock });
    vi.spyOn(window, "focus").mockImplementation(() => undefined);
    const onClick = vi.fn();
    const notification = showOpenAppNotification({
      body: "Vladimir: hello",
      data: { locale: "ru", conversationType: "direct", conversationId: "chat-1", messageId: "message-1" },
      onClick,
      tag: "officechat-direct-message-1"
    });
    expect(calls[0]).toEqual(["OfficeChat", expect.objectContaining({
      icon: "/icon-192.svg",
      tag: "officechat-direct-message-1"
    })]);
    notification?.onclick?.(new Event("click"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
