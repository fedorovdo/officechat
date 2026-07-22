import type { OfficeChatNotification } from "./api";

export function markNotificationsReadByIds(
  items: OfficeChatNotification[],
  notificationIds: Iterable<string>,
  readAt = new Date().toISOString()
) {
  const ids = new Set(notificationIds);
  if (ids.size === 0) return items;
  return items.map((item) =>
    ids.has(item.id) ? { ...item, is_read: true, read_at: item.read_at ?? readAt } : item
  );
}
