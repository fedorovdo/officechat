"use client";

import { useEffect, useRef, useState } from "react";

import type { OfficeChatMessageReaction } from "../lib/api";
import type { Dictionary } from "../lib/i18n";

export const ALLOWED_MESSAGE_REACTIONS = ["👍", "❤️", "😂", "✅", "🔥", "👀", "🎉", "😮", "😢", "👎"] as const;

export function reactionsForCurrentUser(
  reactions: OfficeChatMessageReaction[],
  currentUserId: string
): OfficeChatMessageReaction[] {
  return reactions.map((reaction) => ({
    ...reaction,
    reacted_by_me: reaction.users.some((user) => user.id === currentUserId)
  }));
}

type MessageReactionsProps = {
  canAddReaction: boolean;
  dictionary: Dictionary;
  disabled?: boolean;
  onAdd: (emoji: string) => Promise<OfficeChatMessageReaction[]>;
  onRemove: (emoji: string) => Promise<OfficeChatMessageReaction[]>;
  reactions: OfficeChatMessageReaction[];
};

export function MessageReactions({
  canAddReaction,
  dictionary,
  disabled = false,
  onAdd,
  onRemove,
  reactions
}: MessageReactionsProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [pendingEmoji, setPendingEmoji] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  function reactionTitle(reaction: OfficeChatMessageReaction) {
    const visibleNames = reaction.users.slice(0, 2).map((user) => user.display_name);
    const remainingCount = Math.max(0, reaction.count - visibleNames.length);
    if (remainingCount > 0) {
      visibleNames.push(dictionary.messages.reactions.andMore.replace("{count}", String(remainingCount)));
    }
    return visibleNames.join(", ");
  }

  async function updateReaction(emoji: string, remove: boolean) {
    if (pendingEmoji || disabled) return;
    setError("");
    setPendingEmoji(emoji);
    try {
      await (remove ? onRemove(emoji) : onAdd(emoji));
      if (!remove) setIsOpen(false);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.messages.reactions.updateError);
    } finally {
      setPendingEmoji(null);
    }
  }

  if (reactions.length === 0 && !canAddReaction) return null;

  return (
    <div className="message-reactions" ref={rootRef}>
      <div aria-label={dictionary.messages.reactions.label} className="message-reaction-chips">
        {reactions.map((reaction) => {
          const canToggle = canAddReaction || reaction.reacted_by_me;
          return (
            <button
              aria-label={`${reaction.reacted_by_me ? dictionary.messages.reactions.remove : dictionary.messages.reactions.add} ${reaction.emoji}`}
              aria-busy={pendingEmoji === reaction.emoji}
              className={`message-reaction-chip${reaction.reacted_by_me ? " message-reaction-chip-active" : ""}${pendingEmoji === reaction.emoji ? " message-reaction-chip-pending" : ""}`}
              disabled={disabled || pendingEmoji !== null || !canToggle}
              key={reaction.emoji}
              onClick={() => void updateReaction(reaction.emoji, reaction.reacted_by_me)}
              title={reactionTitle(reaction)}
              type="button"
            >
              <span>{reaction.emoji}</span>
              <span>{reaction.count}</span>
            </button>
          );
        })}
        {canAddReaction ? (
          <button
            aria-expanded={isOpen}
            aria-haspopup="menu"
            aria-label={dictionary.messages.reactions.add}
            className="message-reaction-add"
            disabled={disabled || pendingEmoji !== null}
            onClick={() => {
              setError("");
              setIsOpen((current) => !current);
            }}
            title={dictionary.messages.reactions.add}
            type="button"
          >
            +
          </button>
        ) : null}
      </div>
      {isOpen ? (
        <div aria-label={dictionary.messages.reactions.add} className="message-reaction-menu" role="menu">
          {ALLOWED_MESSAGE_REACTIONS.map((emoji) => (
            <button
              aria-label={`${dictionary.messages.reactions.add} ${emoji}`}
              aria-busy={pendingEmoji === emoji}
              disabled={pendingEmoji !== null}
              key={emoji}
              onClick={() => void updateReaction(emoji, false)}
              role="menuitem"
              type="button"
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <span className="message-reaction-error" role="alert">{error}</span> : null}
    </div>
  );
}
