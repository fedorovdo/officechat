import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { unreadFactory } from "./factories";

const mocks = vi.hoisted(() => ({
  getUnreadSummary: vi.fn(),
  markChatRead: vi.fn(),
  authenticationListener: null as null | (() => void)
}));

vi.mock("../lib/api", () => ({
  getUnreadSummary: mocks.getUnreadSummary,
  markChatRead: mocks.markChatRead
}));

vi.mock("../lib/session", () => ({
  onAuthenticationExpired: vi.fn((listener: () => void) => {
    mocks.authenticationListener = listener;
    return () => {
      mocks.authenticationListener = null;
    };
  })
}));

import { formatUnreadCount, useUnreadStore } from "../lib/useUnreadStore";
import { useVisibleReadMarker } from "../lib/useVisibleReadMarker";

describe("unread store", () => {
  beforeEach(() => {
    mocks.getUnreadSummary.mockResolvedValue(unreadFactory());
    mocks.markChatRead.mockResolvedValue({
      chat_type: "group",
      chat_id: "group-1",
      last_read_message_id: "message-2",
      last_read_message_created_at: "2026-07-04T10:00:00Z",
      last_read_at: "2026-07-04T10:00:00Z",
      unread_count: 0,
      mention_count: 0,
      total_unread: 3
    });
  });

  it("loads the initial authoritative snapshot and individual counters", async () => {
    const { result } = renderHook(() => useUnreadStore("token", "user-1"));
    await waitFor(() => expect(result.current.summary.total).toBe(5));
    expect(result.current.summary.groups).toBe(2);
    expect(result.current.summary.direct).toBe(3);
    expect(result.current.getChat("group", "group-1")?.unread_count).toBe(2);
  });

  it("formats counts above 99 as 99+", () => {
    expect(formatUnreadCount(0)).toBe("0");
    expect(formatUnreadCount(99)).toBe("99");
    expect(formatUnreadCount(100)).toBe("99+");
  });

  it("applies unread.updated to chat and category totals", async () => {
    const { result } = renderHook(() => useUnreadStore("token", "user-1"));
    await waitFor(() => expect(result.current.summary.total).toBe(5));
    act(() => result.current.applyUnreadEvent({
      type: "unread.updated",
      chat_type: "group",
      chat_id: "group-1",
      unread_count: 4,
      mention_count: 2,
      total_unread: 7,
      last_read_message_id: null,
      first_unread_message_id: "message-1",
      newest_unread_message_id: "message-4"
    }));
    expect(result.current.summary.total).toBe(7);
    expect(result.current.summary.groups).toBe(4);
    expect(result.current.getChat("group", "group-1")?.mention_count).toBe(2);
  });

  it("clears a chat optimistically and reconciles the server result", async () => {
    const { result } = renderHook(() => useUnreadStore("token", "user-1"));
    await waitFor(() => expect(result.current.summary.total).toBe(5));
    await act(async () => result.current.markRead("group", "group-1", "message-2"));
    expect(mocks.markChatRead).toHaveBeenCalledWith("token", "group", "group-1", "message-2");
    expect(result.current.getChat("group", "group-1")).toBeUndefined();
    expect(result.current.summary.groups).toBe(0);
    expect(result.current.summary.total).toBe(3);
  });

  it("clears unread state on logout/authentication expiry", async () => {
    const { result } = renderHook(() => useUnreadStore("token", "user-1"));
    await waitFor(() => expect(result.current.summary.total).toBe(5));
    act(() => mocks.authenticationListener?.());
    expect(result.current.summary.total).toBe(0);
    expect(result.current.summary.chats).toEqual([]);
  });

  it("reloads authoritative state after reconnect", async () => {
    const { result } = renderHook(() => useUnreadStore("token", "user-1"));
    await waitFor(() => expect(mocks.getUnreadSummary).toHaveBeenCalledTimes(1));
    mocks.getUnreadSummary.mockResolvedValue(unreadFactory({ total: 9, groups: 6, direct: 3 }));
    await act(async () => result.current.reload());
    expect(result.current.summary.total).toBe(9);
    expect(mocks.getUnreadSummary).toHaveBeenCalledTimes(2);
  });
});

describe("visible read marker", () => {
  beforeEach(() => vi.useFakeTimers());

  function renderMarker(visibility: "visible" | "hidden", unread = true) {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
    const panel = document.createElement("section");
    panel.getClientRects = () => [{ width: 100, height: 100 } as DOMRect] as unknown as DOMRectList;
    const onMarkRead = vi.fn();
    renderHook(() => useVisibleReadMarker({
      messages: [{ id: "old" }, { id: "newest" }],
      onMarkRead,
      panelRef: { current: panel },
      unread: unread ? {
        chat_type: "group",
        chat_id: "group-1",
        unread_count: 2,
        mention_count: 0,
        first_unread_message_id: "old",
        newest_unread_message_id: "newest"
      } : undefined
    }));
    return onMarkRead;
  }

  it("marks the newest message after the visibility debounce", () => {
    const onMarkRead = renderMarker("visible");
    act(() => vi.advanceTimersByTime(500));
    expect(onMarkRead).toHaveBeenCalledWith("newest");
  });

  it("does not mark read while the document is hidden", () => {
    const onMarkRead = renderMarker("hidden");
    act(() => vi.advanceTimersByTime(1000));
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it("does not advance the marker for an old search context", () => {
    const onMarkRead = renderMarker("visible", false);
    act(() => vi.advanceTimersByTime(1000));
    expect(onMarkRead).not.toHaveBeenCalled();
  });
});
