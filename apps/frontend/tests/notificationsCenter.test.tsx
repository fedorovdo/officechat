import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  NotificationBell,
  NotificationCenter,
  type NotificationCenterFilter
} from "../components/NotificationCenter";
import en from "../dictionaries/en.json";
import type { OfficeChatNotification } from "../lib/api";
import {
  markAllNotificationItemsRead,
  markNotificationsReadByIds
} from "../lib/notificationState";

function notification(overrides: Partial<OfficeChatNotification> = {}): OfficeChatNotification {
  return {
    id: "notification-1",
    type: "mention",
    category: "messages",
    source_type: "message",
    source_id: "message-1",
    chat_type: "group",
    chat_id: "group-1",
    message_id: "message-1",
    actor: {
      id: "user-1",
      username: "vladimir",
      display_name: "Vladimir",
      avatar_url: null
    },
    title_key: "notification.mention",
    body_preview: "Please check this",
    metadata: null,
    is_read: false,
    read_at: null,
    is_dismissed: false,
    dismissed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

function renderCenter(props: Partial<Parameters<typeof NotificationCenter>[0]> = {}) {
  const noop = vi.fn();
  return render(
    <NotificationCenter
      dictionary={en}
      filter={(props.filter as NotificationCenterFilter) ?? "all"}
      hasMore={false}
      isLoading={false}
      isOpen
      items={[notification()]}
      locale="en"
      onClose={noop}
      onDismiss={noop}
      onFilterChange={noop}
      onLoadMore={noop}
      onMarkAllRead={noop}
      onMarkRead={noop}
      onOpen={noop}
      unreadCount={1}
      {...props}
    />
  );
}

describe("notification center", () => {
  it("marks linked message notifications without touching calendar or announcements", () => {
    const message = notification({ id: "message-notification", category: "messages" });
    const calendar = notification({ id: "calendar-notification", category: "calendar", type: "calendar_reminder" });
    const announcement = notification({ id: "announcement-notification", category: "announcements", type: "announcement" });
    const result = markNotificationsReadByIds(
      [message, calendar, announcement],
      [message.id],
      "2026-07-22T10:00:00Z"
    );
    expect(result[0]).toMatchObject({ is_read: true, read_at: "2026-07-22T10:00:00Z" });
    expect(result[1].is_read).toBe(false);
    expect(result[2].is_read).toBe(false);
  });

  it("renders bell badge and hides it at zero", () => {
    const { rerender } = render(<NotificationBell dictionary={en} onClick={vi.fn()} unreadCount={120} />);
    expect(screen.getByRole("button", { name: "120 unread notifications" })).toHaveTextContent("99+");

    rerender(<NotificationBell dictionary={en} onClick={vi.fn()} unreadCount={0} />);
    expect(screen.getByRole("button", { name: "Notifications" })).not.toHaveTextContent("99+");
  });

  it("renders drawer items and action buttons", () => {
    const onOpen = vi.fn();
    const onMarkRead = vi.fn();
    const onDismiss = vi.fn();
    renderCenter({ onOpen, onMarkRead, onDismiss });

    const card = screen.getByText("You were mentioned").closest("article");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("Please check this")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("changes filters and can mark all read", () => {
    const onFilterChange = vi.fn();
    const onMarkAllRead = vi.fn();
    renderCenter({ onFilterChange, onMarkAllRead });

    fireEvent.click(screen.getByRole("tab", { name: "Unread" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));

    expect(onFilterChange).toHaveBeenCalledWith("unread");
    expect(onMarkAllRead).toHaveBeenCalledTimes(1);
  });

  it("marks all notification records without changing conversation unread state", () => {
    const notifications = [
      notification({ id: "message-notification", category: "messages" }),
      notification({ id: "calendar-notification", category: "calendar", type: "calendar_reminder" })
    ];
    const conversationUnread = { groupId: "group-1", unreadCount: 8 };

    expect(markAllNotificationItemsRead(notifications, "2026-07-23T10:00:00Z")).toEqual([
      expect.objectContaining({ id: "message-notification", is_read: true }),
      expect.objectContaining({ id: "calendar-notification", is_read: true })
    ]);
    expect(conversationUnread).toEqual({ groupId: "group-1", unreadCount: 8 });
  });

  it("explains mark-all semantics after a successful action", () => {
    renderCenter({ feedback: en.notifications.markAllReadNotice, unreadCount: 0 });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Notifications marked as read. Unseen chat messages remain unread."
    );
  });
});
