"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getUnreadSummary,
  markAllCurrentRead,
  markChatRead,
  type ChatType,
  type LegacyUnreadRepairResult,
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

export function useUnreadStore(
  token: string | null,
  currentUserId: string | null,
  onReadState?: (state: OfficeChatReadState) => void
) {
  const [summary, setSummary] = useState<OfficeChatUnreadSummary>(emptySummary);
  const [isLoading, setIsLoading] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<Promise<void> | null>(null);
  const repairRequestRef = useRef<
    Promise<{ result: LegacyUnreadRepairResult; applied: boolean }> | null
  >(null);
  const sessionGenerationRef = useRef(0);
  const markReadVersionsRef = useRef(new Map<string, number>());
  const authoritativeVersionRef = useRef(0);
  const onReadStateRef = useRef(onReadState);
  onReadStateRef.current = onReadState;

  const reload = useCallback(async () => {
    if (!token) return;
    if (requestRef.current) return requestRef.current;
    const generation = sessionGenerationRef.current;
    const authoritativeVersion = authoritativeVersionRef.current;
    let request!: Promise<void>;
    request = (async () => {
      let shouldRetry = false;
      setIsLoading(true);
      try {
        const nextSummary = await getUnreadSummary(token);
        if (sessionGenerationRef.current !== generation) return;
        if (authoritativeVersionRef.current !== authoritativeVersion) {
          shouldRetry = true;
        } else {
          setSummary(nextSummary);
          setIsReady(true);
          authoritativeVersionRef.current += 1;
          setError("");
        }
      } catch (caughtError) {
        if (sessionGenerationRef.current !== generation) return;
        setError(caughtError instanceof Error ? caughtError.message : "Unread state unavailable");
      } finally {
        if (sessionGenerationRef.current === generation) setIsLoading(false);
        if (requestRef.current === request) requestRef.current = null;
        if (shouldRetry && sessionGenerationRef.current === generation) {
          queueMicrotask(() => void reload());
        }
      }
    })();
    requestRef.current = request;
    return request;
  }, [token]);

  useEffect(() => {
    sessionGenerationRef.current += 1;
    requestRef.current = null;
    repairRequestRef.current = null;
    setSummary(emptySummary);
    setIsLoading(false);
    setIsReady(false);
    setError("");
    if (token && currentUserId) void reload();
    return onAuthenticationExpired(() => {
      sessionGenerationRef.current += 1;
      requestRef.current = null;
      repairRequestRef.current = null;
      markReadVersionsRef.current.clear();
      authoritativeVersionRef.current += 1;
      setSummary(emptySummary);
      setIsReady(false);
      setError("");
    });
  }, [currentUserId, reload, token]);

  const applyUnreadEvent = useCallback((event: UnreadEvent) => {
    authoritativeVersionRef.current += 1;
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
    if (!token) return false;
    const key = chatKey(chatType, chatId);
    const version = (markReadVersionsRef.current.get(key) ?? 0) + 1;
    const authoritativeVersion = authoritativeVersionRef.current;
    markReadVersionsRef.current.set(key, version);
    try {
      const state = await markChatRead(token, chatType, chatId, messageId);
      if (markReadVersionsRef.current.get(key) !== version) return true;
      if (authoritativeVersionRef.current !== authoritativeVersion) {
        await reload();
        return true;
      }
      reconcileReadState(state);
      onReadStateRef.current?.(state);
      return true;
    } catch {
      if (markReadVersionsRef.current.get(key) === version) await reload();
      return false;
    }
  }, [applyUnreadEvent, reconcileReadState, reload, token]);

  const repairLegacyUnread = useCallback(async () => {
    if (!token) return null;
    if (repairRequestRef.current) return repairRequestRef.current;
    const generation = sessionGenerationRef.current;
    const authoritativeVersion = authoritativeVersionRef.current;
    let request!: Promise<{
      result: LegacyUnreadRepairResult;
      applied: boolean;
    }>;
    request = markAllCurrentRead(token)
      .then((result) => {
        if (sessionGenerationRef.current !== generation) {
          return { result, applied: false };
        }
        if (authoritativeVersionRef.current !== authoritativeVersion) {
          return { result, applied: false };
        }
        setSummary(result.unread);
        setIsReady(true);
        setError("");
        authoritativeVersionRef.current += 1;
        return { result, applied: true };
      })
      .finally(() => {
        if (repairRequestRef.current === request) {
          repairRequestRef.current = null;
        }
      });
    repairRequestRef.current = request;
    return request;
  }, [token]);

  const chatsByKey = useMemo(
    () => Object.fromEntries(summary.chats.map((chat) => [chatKey(chat.chat_type, chat.chat_id), chat])),
    [summary.chats]
  );
  const getChat = useCallback(
    (chatType: ChatType, chatId: string): OfficeChatUnreadChat | undefined =>
      chatsByKey[chatKey(chatType, chatId)],
    [chatsByKey]
  );

  return {
    applyUnreadEvent,
    error,
    getChat,
    isLoading,
    isReady,
    markRead,
    reload,
    repairLegacyUnread,
    summary
  };
}
