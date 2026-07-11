"use client";

import { useEffect, useRef, useState } from "react";

import type { Dictionary } from "../lib/i18n";

type MessageActionsMenuProps = {
  canDelete?: boolean;
  canDiscuss?: boolean;
  canEdit?: boolean;
  canPin?: boolean;
  canReply?: boolean;
  dictionary: Dictionary;
  isPinned?: boolean;
  onDelete?: () => void;
  onDiscuss?: () => void;
  onEdit?: () => void;
  onPinToggle?: () => void;
  onReply?: () => void;
};

export function MessageActionsMenu({
  canDelete = false,
  canDiscuss = false,
  canEdit = false,
  canPin = false,
  canReply = false,
  dictionary,
  isPinned = false,
  onDelete,
  onDiscuss,
  onEdit,
  onPinToggle,
  onReply
}: MessageActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const hasActions = canReply || canDiscuss || canPin || canEdit || canDelete;

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  function runAction(action?: () => void) {
    action?.();
    setIsOpen(false);
  }

  if (!hasActions) {
    return null;
  }

  return (
    <div className="message-actions-menu" ref={menuRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={dictionary.messages.moreActions}
        className="message-actions-trigger"
        onClick={() => setIsOpen((current) => !current)}
        title={dictionary.messages.moreActions}
        type="button"
      >
        {dictionary.messages.actions}
      </button>
      {isOpen ? (
        <div className="message-actions-menu-list" role="menu">
          {canReply ? (
            <button className="message-actions-menu-item" onClick={() => runAction(onReply)} role="menuitem" type="button">
              {dictionary.messages.reply}
            </button>
          ) : null}
          {canDiscuss ? (
            <button className="message-actions-menu-item" onClick={() => runAction(onDiscuss)} role="menuitem" type="button">
              {dictionary.discussions.discuss}
            </button>
          ) : null}
          {canPin ? (
            <button className="message-actions-menu-item" onClick={() => runAction(onPinToggle)} role="menuitem" type="button">
              {isPinned ? dictionary.pins.unpin : dictionary.pins.pin}
            </button>
          ) : null}
          {canEdit ? (
            <button className="message-actions-menu-item" onClick={() => runAction(onEdit)} role="menuitem" type="button">
              {dictionary.messages.edit}
            </button>
          ) : null}
          {canDelete ? (
            <button className="message-actions-menu-item" onClick={() => runAction(onDelete)} role="menuitem" type="button">
              {dictionary.messages.delete}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
