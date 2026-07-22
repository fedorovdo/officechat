import type { WindowActivity } from "./useWindowActivity";

export type OpenAppNotificationData = {
  locale: "ru" | "en";
  conversationType: "group" | "direct" | "discussion" | "other";
  conversationId: string;
  messageId: string;
};

export function notificationDedupeKey(data: OpenAppNotificationData) {
  return `${data.conversationType}:${data.conversationId}:${data.messageId}`;
}

export function shouldShowOpenAppNotification(options: {
  activity: WindowActivity;
  enabled: boolean;
  permission: NotificationPermission | "unsupported";
  senderUserId: string;
  currentUserId: string;
  duplicate: boolean;
}) {
  if (options.senderUserId === options.currentUserId) return "senderIsCurrentUser" as const;
  if (!options.enabled) return "notificationsDisabled" as const;
  if (options.permission === "unsupported") return "unsupported" as const;
  if (options.permission !== "granted") return "permissionNotGranted" as const;
  if (options.activity.isActive) return "tabActive" as const;
  if (options.duplicate) return "duplicate" as const;
  return null;
}

export function showOpenAppNotification(options: {
  body: string;
  data: OpenAppNotificationData;
  onClick: () => void;
  tag: string;
}) {
  if (typeof window === "undefined" || !("Notification" in window)) return null;
  const notification = new Notification("OfficeChat", {
    body: options.body,
    data: options.data,
    icon: "/icon-192.svg",
    tag: options.tag
  });
  notification.onclick = () => {
    window.focus();
    options.onClick();
    notification.close();
  };
  return notification;
}
