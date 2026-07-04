"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getUnreadSummary,
  markChatRead,
  type ChatType,
  type OfficeChatReadState,
  type OfficeChatUnreadChat,
  type OfficeChatUnreadSummary,
  type UnreadEvent
} from "./api";
import { onAuthenticationExpired } from "./session";

const emptySummary: OfficeChatUnreadSummary = {
  total: 0,
  groups: 0,
  direct: 0,
  discussions: 0,
  chats: []
};

function chatKey(chatType: ChatType, chatId: string) {
  return `${chatType}:${chatId}`;
}

function categoryKey(chatType: ChatType): "groups" | "direct" | "discussions" {
  return chatType === "group" ? "groups" : chatType === "direct" ? "direct" : "discussions";
}

export function formatUnreadCount(count: number) {
  return count > 99 ? "99+" : String(count);
}

export function useUnreadStore(token: string | null, currentUserId: string | null) {
  const [summary, setSummary] = useState<OfficeChatUnreadSummary>(emptySummary);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<Promise<void> | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    if (requestRef.current) return requestRef.current;
    const request = (async () => {
      setIsLoading(true);
      try {
        setSummary(await getUnreadSummary(token));
        setError("");
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Unread state unavailable");
      } finally {
        setIsLoading(false);
        requestRef.current = null;
      }
    })();
    requestRef.current = request;
    return request;
  }, [token]);

  useEffect(() => {
    setSummary(emptySummary);
    setError("");
    if (token && currentUserId) void reload();
    return onAuthenticationExpired(() => {
      requestRef.current = null;
      setSummary(emptySummary);
      setError("");
    });
  }, [currentUserId, reload, token]);

  const applyUnreadEvent = useCallback((event: UnreadEvent) => {
    setSummary((current) => {
      const currentIndex = current.chats.findIndex(
        (chat) => chat.chat_type === event.chat_type && chat.chat_id === event.chat_id
      );
      const previous = currentIndex >= 0 ? current.chats[currentIndex] : undefined;
      const previousCount = previous?.unread_count ?? 0;
      const nextChats = current.chats.filter(
        (chat) => !(chat.chat_type === event.chat_type && chat.chat_id === event.chat_id)
      );
      if (!event.removed && event.unread_count > 0) {
        nextChats.push({
          chat_type: event.chat_type,
          chat_id: event.chat_id,
          unread_count: event.unread_count,
          mention_count: event.mention_count,
          first_unread_message_id:
            event.first_unread_message_id ?? previous?.first_unread_message_id ?? null,
          newest_unread_message_id:
            event.newest_unread_message_id ?? previous?.newest_unread_message_id ?? null
        });
      }
      const delta = event.unread_count - previousCount;
      const category = categoryKey(event.chat_type);
      return {
        ...current,
        chats: nextChats,
        [category]: Math.max(0, current[category] + delta),
        total: event.total_unread ?? Math.max(0, current.total + delta)
      };
    });
  }, []);

  const reconcileReadState = useCallback((state: OfficeChatReadState) => {
    applyUnreadEvent({
      type: "unread.updated",
      chat_type: state.chat_type,
      chat_id: state.chat_id,
      unread_count: state.unread_count,
      mention_count: state.mention_count,
      total_unread: state.total_unread,
      last_read_message_id: state.last_read_message_id
    });
  }, [applyUnreadEvent]);

  const markRead = useCallback(async (chatType: ChatType, chatId: string, messageId: string) => {
    if (!token) return;
    applyUnreadEvent({
      type: "unread.updated",
      chat_type: chatType,
      chat_id: chatId,
      unread_count: 0,
      mention_count: 0,
      total_unread: null,
      last_read_message_id: messageId
    });
    try {
      reconcileReadState(await markChatRead(token, chatType, chatId, messageId));
    } catch {
      await reload();
    }
  }, [applyUnreadEvent, reconcileReadState, reload, token]);

  const chatsByKey = useMemo(
    () => Object.fromEntries(summary.chats.map((chat) => [chatKey(chat.chat_type, chat.chat_id), chat])),
    [summary.chats]
  );
  const getChat = useCallback(
    (chatType: ChatType, chatId: string): OfficeChatUnreadChat | undefined =>
      chatsByKey[chatKey(chatType, chatId)],
    [chatsByKey]
  );

  return { applyUnreadEvent, error, getChat, isLoading, markRead, reload, summary };
}
