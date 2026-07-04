"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import type { ResilientWebSocketConnection } from "./resilientWebSocket";
import type { TypingEvent } from "./api";

export type TypingUser = { userId: string; displayName: string };

export function useTyping(
  socketRef: MutableRefObject<ResilientWebSocketConnection | null>,
  currentUserId: string,
  contextKey: string
) {
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const outgoingActiveRef = useRef(false);
  const lastStartRef = useRef(0);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const incomingTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const stopTyping = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = null;
    if (outgoingActiveRef.current) socketRef.current?.send({ type: "typing.stop" });
    outgoingActiveRef.current = false;
    lastStartRef.current = 0;
  }, [socketRef]);

  const notifyTyping = useCallback((value: string) => {
    if (!value) {
      stopTyping();
      return;
    }
    const now = Date.now();
    if (!outgoingActiveRef.current || now - lastStartRef.current >= 3000) {
      const sent = socketRef.current?.send({ type: "typing.start" }) ?? false;
      outgoingActiveRef.current = outgoingActiveRef.current || sent;
      if (sent) lastStartRef.current = now;
    }
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = setTimeout(stopTyping, 2500);
  }, [socketRef, stopTyping]);

  const handleTypingEvent = useCallback((event: TypingEvent) => {
    if (event.user_id === currentUserId) return true;
    const existingTimer = incomingTimersRef.current.get(event.user_id);
    if (existingTimer) clearTimeout(existingTimer);
    incomingTimersRef.current.delete(event.user_id);

    setTypingUsers((current) => {
      const withoutUser = current.filter((user) => user.userId !== event.user_id);
      return event.is_typing
        ? [...withoutUser, { userId: event.user_id, displayName: event.display_name }]
        : withoutUser;
    });
    if (event.is_typing) {
      incomingTimersRef.current.set(event.user_id, setTimeout(() => {
        incomingTimersRef.current.delete(event.user_id);
        setTypingUsers((current) => current.filter((user) => user.userId !== event.user_id));
      }, 7000));
    }
    return true;
  }, [currentUserId]);

  useEffect(() => {
    setTypingUsers([]);
    return () => {
      stopTyping();
      for (const timer of incomingTimersRef.current.values()) clearTimeout(timer);
      incomingTimersRef.current.clear();
    };
  }, [contextKey, stopTyping]);

  return { handleTypingEvent, notifyTyping, stopTyping, typingUsers };
}
