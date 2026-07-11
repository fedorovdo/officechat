import type { Locale } from "../lib/i18n";
import { formatUnreadCount } from "../lib/useUnreadStore";

type AnnouncementUnreadBadgeProps = {
  count: number;
  locale: Locale;
};

export function formatAnnouncementUnreadLabel(count: number, locale: Locale) {
  if (locale === "ru") {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) {
      return `${count} непрочитанное объявление`;
    }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
      return `${count} непрочитанных объявления`;
    }
    return `${count} непрочитанных объявлений`;
  }
  return `${count} unread announcement${count === 1 ? "" : "s"}`;
}

export function AnnouncementUnreadBadge({ count, locale }: AnnouncementUnreadBadgeProps) {
  if (count <= 0) {
    return null;
  }

  const label = formatAnnouncementUnreadLabel(count, locale);

  return (
    <span
      aria-label={label}
      className="sidebar-unread-badge announcement-unread-badge"
      title={label}
    >
      {formatUnreadCount(count)}
    </span>
  );
}
