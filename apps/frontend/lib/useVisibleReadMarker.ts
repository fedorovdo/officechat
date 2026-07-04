"use client";

import { useEffect, useRef, type RefObject } from "react";

import type { OfficeChatUnreadChat } from "./api";

type VisibleReadMarkerOptions = {
  messages: Array<{ id: string }>;
  onMarkRead?: (messageId: string) => void | Promise<void>;
  panelRef: RefObject<HTMLElement | null>;
  unread?: OfficeChatUnreadChat;
};

export function useVisibleReadMarker({ messages, onMarkRead, panelRef, unread }: VisibleReadMarkerOptions) {
  const lastMarkedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!onMarkRead || !unread?.unread_count || messages.length === 0) return;
    const markRead = onMarkRead;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function scheduleIfVisible() {
      if (document.visibilityState !== "visible") return;
      const panel = panelRef.current;
      if (!panel || panel.getClientRects().length === 0) return;
      const newestMessageId = messages[messages.length - 1]?.id;
      if (!newestMessageId || lastMarkedRef.current === newestMessageId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.visibilityState !== "visible" || !panelRef.current?.getClientRects().length) return;
        lastMarkedRef.current = newestMessageId;
        void markRead(newestMessageId);
      }, 500);
    }

    scheduleIfVisible();
    document.addEventListener("visibilitychange", scheduleIfVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", scheduleIfVisible);
    };
  }, [messages, onMarkRead, panelRef, unread?.unread_count]);
}
