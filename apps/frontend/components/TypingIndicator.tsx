import type { Dictionary } from "../lib/i18n";
import type { TypingUser } from "../lib/useTyping";

type TypingIndicatorProps = {
  dictionary: Dictionary;
  direct?: boolean;
  users: TypingUser[];
};

export function TypingIndicator({ dictionary, direct = false, users }: TypingIndicatorProps) {
  let text = "";
  if (users.length > 0) {
    if (direct) text = dictionary.typing.direct;
    else if (users.length === 1) text = dictionary.typing.one.replace("{name}", users[0].displayName);
    else if (users.length === 2) {
      text = dictionary.typing.two
        .replace("{first}", users[0].displayName)
        .replace("{second}", users[1].displayName);
    } else text = dictionary.typing.several;
  }
  return <div aria-live="polite" className="typing-indicator">{text}</div>;
}
