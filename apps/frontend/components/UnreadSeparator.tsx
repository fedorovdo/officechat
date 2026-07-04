import type { Dictionary } from "../lib/i18n";

export function UnreadSeparator({ dictionary }: { dictionary: Dictionary }) {
  return (
    <div className="unread-separator" data-unread-separator role="separator">
      <span>{dictionary.unread.separator}</span>
    </div>
  );
}
