import type { Dictionary, Locale } from "../lib/i18n";
import type { OfficeChatPresence } from "../lib/api";

type PresenceStatusProps = {
  compact?: boolean;
  dictionary: Dictionary;
  locale: Locale;
  presence?: OfficeChatPresence;
};

export function formatLastSeen(
  presence: OfficeChatPresence | undefined,
  dictionary: Dictionary,
  locale: Locale
) {
  if (presence?.status === "online") return dictionary.presence.online;
  if (!presence) return dictionary.presence.unknown;
  if (!presence?.last_seen_at) return dictionary.presence.offline;
  const date = new Date(presence.last_seen_at);
  if (Number.isNaN(date.getTime())) return dictionary.presence.offline;
  const now = new Date();
  const differenceMinutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60000));
  if (differenceMinutes < 1) return dictionary.presence.justNow;
  if (differenceMinutes < 60) {
    return dictionary.presence.minutesAgo.replace("{count}", String(differenceMinutes));
  }
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference = Math.round((today.getTime() - targetDay.getTime()) / 86400000);
  if (dayDifference === 0) return dictionary.presence.todayAt.replace("{time}", time);
  if (dayDifference === 1) return dictionary.presence.yesterdayAt.replace("{time}", time);
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
  return dictionary.presence.dateAt.replace("{date}", day).replace("{time}", time);
}

export function PresenceStatus({ compact = false, dictionary, locale, presence }: PresenceStatusProps) {
  const label = formatLastSeen(presence, dictionary, locale);
  const online = presence?.status === "online";
  return (
    <span
      aria-label={label}
      className={`presence-status ${online ? "presence-status-online" : "presence-status-offline"}`}
      title={label}
    >
      <span aria-hidden="true" className="presence-dot" />
      {!compact ? <span>{label}</span> : <span className="visually-hidden">{label}</span>}
    </span>
  );
}
