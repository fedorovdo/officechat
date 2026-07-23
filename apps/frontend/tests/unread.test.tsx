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
    expect(result.current.isReady).toBe(true);
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

  it("reconciles a chat from the server result", async () => {
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
    expect(result.current.isReady).toBe(false);
  });

  it("ignores an unread snapshot that resolves after authentication expiry", async () => {
    let resolveSnapshot!: (value: ReturnType<typeof unreadFactory>) => void;
    mocks.getUnreadSummary.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSnapshot = resolve; })
    );
    const { result } = renderHook(() => useUnreadStore("token", "user-1"));
    await waitFor(() => expect(mocks.getUnreadSummary).toHaveBeenCalledTimes(1));
    act(() => mocks.authenticationListener?.());
    resolveSnapshot(unreadFactory({ total: 11, groups: 8, direct: 3 }));
    await act(async () => Promise.resolve());
    expect(result.current.summary).toEqual({
      total: 0,
      groups: 0,
      direct: 0,
      discussions: 0,
      chats: []
    });
  });

  it("reloads authoritative state after reconnect", async () => {
    const { result } = renderHook(() => useUnreadStore("token", "user-1"));
    await waitFor(() => expect(mocks.getUnreadSummary).toHaveBeenCalledTimes(1));
    mocks.getUnreadSummary.mockResolvedValue(unreadFactory({ total: 9, groups: 6, direct: 3 }));
    await act(async () => result.current.reload());
    expect(result.current.summary.total).toBe(9);
    expect(mocks.getUnreadSummary).toHaveBeenCalledTimes(2);
  });

  it("ignores an older mark-read response that arrives last", async () => {
    let resolveOlder!: (value: unknown) => void;
    let resolveNewer!: (value: unknown) => void;
    mocks.markChatRead
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewer = resolve; }));
    const { result } = renderHook(() => useUnreadStore("token", "user-1"));
    await waitFor(() => expect(result.current.summary.total).toBe(5));
    let olderRequest!: Promise<boolean>;
    let newerRequest!: Promise<boolean>;
    act(() => {
      olderRequest = result.current.markRead("group", "group-1", "message-1");
      newerRequest = result.current.markRead("group", "group-1", "message-2");
    });
    resolveNewer({
      chat_type: "group", chat_id: "group-1", last_read_message_id: "message-2",
      last_read_message_created_at: "2026-07-04T10:00:00Z", last_read_at: "2026-07-04T10:00:00Z",
      unread_count: 0, mention_count: 0, total_unread: 3,
      notification_unread_count: 0, read_notification_ids: []
    });
    await act(async () => newerRequest);
    resolveOlder({
      chat_type: "group", chat_id: "group-1", last_read_message_id: "message-1",
      last_read_message_created_at: "2026-07-04T09:59:00Z", last_read_at: "2026-07-04T09:59:00Z",
      unread_count: 1, mention_count: 0, total_unread: 4,
      notification_unread_count: 1, read_notification_ids: []
    });
    await act(async () => olderRequest);
    expect(result.current.summary.total).toBe(3);
    expect(result.current.getChat("group", "group-1")).toBeUndefined();
  });

  it("reloads instead of applying a response older than a websocket event", async () => {
    let resolveRead!: (value: unknown) => void;
    mocks.markChatRead.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const { result } = renderHook(() => useUnreadStore("token", "user-1"));
    await waitFor(() => expect(result.current.summary.total).toBe(5));
    let request!: Promise<boolean>;
    act(() => {
      request = result.current.markRead("group", "group-1", "message-2");
      result.current.applyUnreadEvent({
        type: "unread.updated", chat_type: "direct", chat_id: "direct-1",
        unread_count: 4, mention_count: 0, total_unread: 6,
        last_read_message_id: null, first_unread_message_id: "direct-message-1",
        newest_unread_message_id: "direct-message-4"
      });
    });
    mocks.getUnreadSummary.mockResolvedValueOnce(unreadFactory({ total: 6, groups: 2, direct: 4 }));
    resolveRead({
      chat_type: "group", chat_id: "group-1", last_read_message_id: "message-2",
      last_read_message_created_at: "2026-07-04T10:00:00Z", last_read_at: "2026-07-04T10:00:00Z",
      unread_count: 0, mention_count: 0, total_unread: 3,
      notification_unread_count: 0, read_notification_ids: []
    });
    await act(async () => request);
    expect(result.current.summary.total).toBe(6);
    expect(mocks.getUnreadSummary).toHaveBeenCalledTimes(2);
  });

  it("discards a snapshot older than a websocket event and reloads it", async () => {
    let resolveInitial!: (value: ReturnType<typeof unreadFactory>) => void;
    mocks.getUnreadSummary
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValueOnce(unreadFactory({ total: 6, groups: 3, direct: 3 }));
    const { result } = renderHook(() => useUnreadStore("token", "user-1"));
    await waitFor(() => expect(mocks.getUnreadSummary).toHaveBeenCalledTimes(1));
    act(() => result.current.applyUnreadEvent({
      type: "unread.updated", chat_type: "group", chat_id: "group-1",
      unread_count: 3, mention_count: 0, total_unread: 6,
      last_read_message_id: null, first_unread_message_id: "message-1",
      newest_unread_message_id: "message-3"
    }));
    resolveInitial(unreadFactory({ total: 5 }));
    await waitFor(() => expect(mocks.getUnreadSummary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.summary.total).toBe(6));
    expect(result.current.summary.groups).toBe(3);
  });
});

describe("visible read marker", () => {
  class TestIntersectionObserver {
    static instances: TestIntersectionObserver[] = [];
    readonly callback: IntersectionObserverCallback;
    readonly options?: IntersectionObserverInit;
    readonly observed: Element[] = [];

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.callback = callback;
      this.options = options;
      TestIntersectionObserver.instances.push(this);
    }

    observe(element: Element) { this.observed.push(element); }
    disconnect() { this.observed.length = 0; }
    unobserve(element: Element) { this.observed.splice(this.observed.indexOf(element), 1); }
    takeRecords() { return []; }

    emit(element: Element, ratio: number, dimensions?: { intersectionHeight: number; messageHeight: number; rootHeight: number }) {
      this.callback([
        {
          target: element,
          isIntersecting: ratio > 0,
          intersectionRatio: ratio,
          boundingClientRect: { height: dimensions?.messageHeight ?? 100 },
          intersectionRect: { height: dimensions?.intersectionHeight ?? ratio * 100 },
          rootBounds: { height: dimensions?.rootHeight ?? 100 }
        } as IntersectionObserverEntry
      ], this as unknown as IntersectionObserver);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    TestIntersectionObserver.instances = [];
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: TestIntersectionObserver
    });
  });

  function renderMarker(
    visibility: "visible" | "hidden",
    unread = true,
    focused = true,
    firstUnreadMessageId = "old",
    onMarkRead = vi.fn(),
    chatType: "group" | "direct" | "discussion" = "group",
    senderUserId = "other"
  ) {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
    Object.defineProperty(document, "hidden", { configurable: true, value: visibility === "hidden" });
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focused });
    const container = document.createElement("section");
    const oldMessage = document.createElement("article");
    oldMessage.dataset.messageId = "old";
    const newestMessage = document.createElement("article");
    newestMessage.dataset.messageId = "newest";
    container.append(oldMessage, newestMessage);
    const hook = renderHook(() => useVisibleReadMarker({
      currentUserId: "me",
      messages: [
        { id: "old", sender_user_id: senderUserId, is_deleted: false, is_archived: false },
        { id: "newest", sender_user_id: senderUserId, is_deleted: false, is_archived: false }
      ],
      onMarkRead,
      scrollContainerRef: { current: container },
      unread: unread ? {
        chat_type: chatType,
        chat_id: `${chatType}-1`,
        unread_count: 2,
        mention_count: 0,
        first_unread_message_id: firstUnreadMessageId,
        newest_unread_message_id: "newest"
      } : undefined
    }));
    return { container, newestMessage, oldMessage, onMarkRead, unmount: hook.unmount };
  }

  it("observes the real scroll container at 60 percent and waits 500ms", () => {
    const { newestMessage, oldMessage, onMarkRead } = renderMarker("visible");
    const observer = TestIntersectionObserver.instances[0];
    expect(observer.options?.threshold).toEqual([0, 0.6]);
    observer.emit(oldMessage, 0.6);
    observer.emit(newestMessage, 0.6);
    act(() => vi.advanceTimersByTime(499));
    expect(onMarkRead).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
      vi.runOnlyPendingTimers();
    });
    expect(onMarkRead).toHaveBeenCalledWith("newest");
  });

  it("marks a bot-sent group message after the same 500ms visibility window", () => {
    const { oldMessage, onMarkRead } = renderMarker(
      "visible",
      true,
      true,
      "old",
      vi.fn(),
      "group",
      "zabbix-bot-user"
    );
    TestIntersectionObserver.instances[0].emit(oldMessage, 1);
    act(() => {
      vi.advanceTimersByTime(500);
      vi.runOnlyPendingTimers();
    });
    expect(onMarkRead).toHaveBeenCalledWith("old");
  });

  it.each(["direct", "discussion"] as const)(
    "keeps the %s visible-read regression passing",
    (chatType) => {
      const { oldMessage, onMarkRead } = renderMarker(
        "visible",
        true,
        true,
        "old",
        vi.fn(),
        chatType
      );
      TestIntersectionObserver.instances[0].emit(oldMessage, 1);
      act(() => {
        vi.advanceTimersByTime(500);
        vi.runOnlyPendingTimers();
      });
      expect(onMarkRead).toHaveBeenCalledWith("old");
    }
  );

  it("advances only through a continuously confirmed unread prefix", async () => {
    const { newestMessage, oldMessage, onMarkRead } = renderMarker("visible");
    const observer = TestIntersectionObserver.instances[0];
    observer.emit(oldMessage, 1);
    await act(async () => vi.advanceTimersByTimeAsync(501));
    expect(onMarkRead).toHaveBeenLastCalledWith("old");

    observer.emit(newestMessage, 1);
    await act(async () => vi.advanceTimersByTimeAsync(501));
    expect(onMarkRead).toHaveBeenLastCalledWith("newest");
  });

  it("can confirm an oversized message that fills most of the scroll container", () => {
    const { oldMessage, onMarkRead } = renderMarker("visible", true, true, "old");
    const observer = TestIntersectionObserver.instances[0];
    observer.emit(oldMessage, 0.3, { intersectionHeight: 70, messageHeight: 300, rootHeight: 100 });
    act(() => {
      vi.advanceTimersByTime(500);
      vi.runOnlyPendingTimers();
    });
    expect(onMarkRead).toHaveBeenCalledWith("old");
  });

  it("does not mark read while the document is hidden", () => {
    const { newestMessage, oldMessage, onMarkRead } = renderMarker("hidden");
    TestIntersectionObserver.instances[0].emit(oldMessage, 1);
    TestIntersectionObserver.instances[0].emit(newestMessage, 1);
    act(() => vi.advanceTimersByTime(1000));
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it("waits another 500ms after focus is restored", () => {
    let focused = false;
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focused });
    const { newestMessage, oldMessage, onMarkRead } = renderMarker("visible", true, false);
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focused });
    TestIntersectionObserver.instances[0].emit(oldMessage, 1);
    TestIntersectionObserver.instances[0].emit(newestMessage, 1);
    act(() => vi.advanceTimersByTime(1000));
    focused = true;
    act(() => window.dispatchEvent(new Event("focus")));
    act(() => vi.advanceTimersByTime(499));
    expect(onMarkRead).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
      vi.runOnlyPendingTimers();
    });
    expect(onMarkRead).toHaveBeenCalledWith("newest");
  });

  it("does not mark a message during rapid scrolling", () => {
    const { newestMessage, oldMessage, onMarkRead } = renderMarker("visible");
    const observer = TestIntersectionObserver.instances[0];
    observer.emit(oldMessage, 0.8);
    observer.emit(newestMessage, 0.8);
    act(() => vi.advanceTimersByTime(200));
    observer.emit(oldMessage, 0.2);
    observer.emit(newestMessage, 0.2);
    act(() => vi.advanceTimersByTime(1000));
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it("disconnects the observer and cancels timers on unmount", () => {
    const { oldMessage, onMarkRead, unmount } = renderMarker("visible");
    const observer = TestIntersectionObserver.instances[0];
    observer.emit(oldMessage, 1);
    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(observer.observed).toEqual([]);
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it("cancels the old visibility timer when switching from group A to group B", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
    const container = document.createElement("section");
    const groupAMessage = document.createElement("article");
    groupAMessage.dataset.messageId = "group-a-message";
    const groupBMessage = document.createElement("article");
    groupBMessage.dataset.messageId = "group-b-message";
    container.append(groupAMessage, groupBMessage);
    const onMarkRead = vi.fn();
    const { rerender } = renderHook(
      ({ chatId, messageId }: { chatId: string; messageId: string }) =>
        useVisibleReadMarker({
          currentUserId: "me",
          messages: [
            { id: messageId, sender_user_id: "other", is_deleted: false, is_archived: false }
          ],
          onMarkRead,
          scrollContainerRef: { current: container },
          unread: {
            chat_type: "group",
            chat_id: chatId,
            unread_count: 1,
            mention_count: 0,
            first_unread_message_id: messageId,
            newest_unread_message_id: messageId
          }
        }),
      { initialProps: { chatId: "group-a", messageId: "group-a-message" } }
    );

    const groupAObserver = TestIntersectionObserver.instances[0];
    groupAObserver.emit(groupAMessage, 1);
    act(() => vi.advanceTimersByTime(200));
    rerender({ chatId: "group-b", messageId: "group-b-message" });
    act(() => vi.advanceTimersByTime(1000));
    expect(onMarkRead).not.toHaveBeenCalled();

    const groupBObserver = TestIntersectionObserver.instances[1];
    groupBObserver.emit(groupBMessage, 1);
    act(() => {
      vi.advanceTimersByTime(500);
      vi.runOnlyPendingTimers();
    });
    expect(onMarkRead).toHaveBeenCalledWith("group-b-message");
  });

  it("does not advance the marker for an old search context", () => {
    const { onMarkRead } = renderMarker("visible", false);
    act(() => vi.advanceTimersByTime(1000));
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it("does not skip an earlier unread message that was not visible", () => {
    const { newestMessage, onMarkRead } = renderMarker("visible");
    TestIntersectionObserver.instances[0].emit(newestMessage, 1);
    act(() => vi.advanceTimersByTime(1000));
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it("fails closed when pagination omitted the first unread message", () => {
    const { newestMessage, oldMessage, onMarkRead } = renderMarker("visible", true, true, "not-loaded");
    expect(TestIntersectionObserver.instances).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1000));
    expect(onMarkRead).not.toHaveBeenCalled();
    expect(oldMessage).toBeDefined();
    expect(newestMessage).toBeDefined();
  });

  it("retries after a failed mark-read request", async () => {
    const onMarkRead = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { newestMessage, oldMessage } = renderMarker("visible", true, true, "old", onMarkRead);
    const observer = TestIntersectionObserver.instances[0];
    observer.emit(oldMessage, 1);
    observer.emit(newestMessage, 1);
    await act(async () => vi.advanceTimersByTimeAsync(501));
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(501));
    expect(onMarkRead).toHaveBeenCalledTimes(2);
  });
});
