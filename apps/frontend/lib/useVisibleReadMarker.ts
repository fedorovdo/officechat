"use client";

import { useEffect, useRef, type RefObject } from "react";

import type { OfficeChatUnreadChat } from "./api";
import { readWindowActivity, subscribeWindowActivity } from "./useWindowActivity";

type VisibleReadMarkerOptions = {
  currentUserId: string;
  messages: Array<{ id: string; is_archived: boolean; is_deleted: boolean; sender_user_id: string }>;
  onMarkRead?: (messageId: string) => boolean | void | Promise<boolean | void>;
  scrollContainerRef: RefObject<HTMLElement | null>;
  unread?: OfficeChatUnreadChat;
};

type InitialMessageScrollOptions = {
  conversationKey: string;
  enabled: boolean;
  messages: Array<{ id: string }>;
  onFallbackToLatest: () => void;
  scrollContainerRef: RefObject<HTMLElement | null>;
  skip?: boolean;
  targetMessageId?: string | null;
};

export function scrollUnreadMessageIntoView(
  scrollContainer: HTMLElement | null,
  messageId: string | null | undefined
) {
  if (!scrollContainer || !messageId) return false;
  const message = Array.from(
    scrollContainer.querySelectorAll<HTMLElement>("[data-message-id]")
  ).find((element) => element.dataset.messageId === messageId);
  if (!message) return false;
  const rootRect = scrollContainer.getBoundingClientRect();
  const messageRect = message.getBoundingClientRect();
  const viewportHeight = scrollContainer.clientHeight || rootRect.height;
  const nextTop = Math.max(
    0,
    scrollContainer.scrollTop + messageRect.top - rootRect.top - viewportHeight / 3
  );
  if (typeof scrollContainer.scrollTo === "function") {
    scrollContainer.scrollTo({ top: nextTop, behavior: "auto" });
  } else {
    scrollContainer.scrollTop = nextTop;
  }
  return true;
}

export function useInitialMessageScroll({
  conversationKey,
  enabled,
  messages,
  onFallbackToLatest,
  scrollContainerRef,
  skip = false,
  targetMessageId
}: InitialMessageScrollOptions) {
  const lifecycleRef = useRef({
    conversationKey,
    completed: false,
    positioning: false,
    userInteracted: false
  });
  const onFallbackRef = useRef(onFallbackToLatest);
  onFallbackRef.current = onFallbackToLatest;

  useEffect(() => {
    lifecycleRef.current = {
      conversationKey,
      completed: false,
      positioning: false,
      userInteracted: false
    };
  }, [conversationKey]);

  useEffect(() => {
    if (skip && lifecycleRef.current.conversationKey === conversationKey) {
      lifecycleRef.current.completed = true;
    }
  }, [conversationKey, skip]);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root) return;
    const markUserInteraction = () => {
      const lifecycle = lifecycleRef.current;
      if (
        lifecycle.conversationKey !== conversationKey ||
        lifecycle.completed ||
        lifecycle.positioning
      ) return;
      lifecycle.userInteracted = true;
      lifecycle.completed = true;
    };
    root.addEventListener("wheel", markUserInteraction, { passive: true });
    root.addEventListener("touchmove", markUserInteraction, { passive: true });
    root.addEventListener("pointerdown", markUserInteraction, { passive: true });
    root.addEventListener("keydown", markUserInteraction);
    root.addEventListener("scroll", markUserInteraction, { passive: true });
    return () => {
      root.removeEventListener("wheel", markUserInteraction);
      root.removeEventListener("touchmove", markUserInteraction);
      root.removeEventListener("pointerdown", markUserInteraction);
      root.removeEventListener("keydown", markUserInteraction);
      root.removeEventListener("scroll", markUserInteraction);
    };
  }, [conversationKey, scrollContainerRef]);

  useEffect(() => {
    if (!enabled || skip || messages.length === 0) return;
    const lifecycle = lifecycleRef.current;
    if (lifecycle.conversationKey !== conversationKey || lifecycle.completed || lifecycle.userInteracted) return;
    if (!targetMessageId) {
      lifecycle.completed = true;
      onFallbackRef.current();
      return;
    }
    let frame = 0;
    let attempt = 0;
    let disposed = false;

    const positionInitialWindow = () => {
      if (disposed) return;
      const current = lifecycleRef.current;
      if (
        current.conversationKey !== conversationKey ||
        current.completed ||
        current.userInteracted
      ) return;
      attempt += 1;
      current.positioning = true;
      const positioned = scrollUnreadMessageIntoView(scrollContainerRef.current, targetMessageId);
      if (positioned) {
        current.completed = true;
        current.positioning = false;
        return;
      }
      current.positioning = false;
      if (attempt < 4) {
        frame = requestAnimationFrame(positionInitialWindow);
        return;
      }
      current.completed = true;
      onFallbackRef.current();
    };

    frame = requestAnimationFrame(positionInitialWindow);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
    };
  }, [conversationKey, enabled, messages.length, scrollContainerRef, skip, targetMessageId]);
}

function isSufficientlyVisible(entry: IntersectionObserverEntry) {
  if (!entry.isIntersecting) return false;
  if (entry.intersectionRatio >= 0.6) return true;
  const rootHeight = entry.rootBounds?.height ?? 0;
  const messageHeight = entry.boundingClientRect.height;
  if (messageHeight <= rootHeight || rootHeight <= 0) return false;
  if (entry.intersectionRect.height >= rootHeight * 0.5) return true;
  const rootBottom = entry.rootBounds?.bottom;
  const messageBottom = entry.boundingClientRect.bottom;
  const reachedMessageBottom =
    typeof rootBottom === "number" &&
    typeof messageBottom === "number" &&
    messageBottom <= rootBottom + 1;
  return reachedMessageBottom && entry.intersectionRect.height >= Math.min(120, rootHeight * 0.25);
}

export function useVisibleReadMarker({ currentUserId, messages, onMarkRead, scrollContainerRef, unread }: VisibleReadMarkerOptions) {
  const lastMarkedRef = useRef<string | null>(null);
  const lastChatKeyRef = useRef<string | null>(null);
  const onMarkReadRef = useRef(onMarkRead);
  onMarkReadRef.current = onMarkRead;
  const chatKey = unread ? `${unread.chat_type}:${unread.chat_id}` : null;
  if (lastChatKeyRef.current !== chatKey) {
    lastChatKeyRef.current = chatKey;
    lastMarkedRef.current = null;
  }

  useEffect(() => {
    if (!onMarkReadRef.current || !unread?.unread_count || messages.length === 0) return;
    const root = scrollContainerRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const firstUnreadIndex = unread.first_unread_message_id
      ? messages.findIndex((message) => message.id === unread.first_unread_message_id)
      : 0;
    if (firstUnreadIndex < 0) return;
    const orderedCandidateIds = messages
      .slice(firstUnreadIndex)
      .filter(
        (message) =>
          message.sender_user_id !== currentUserId && !message.is_deleted && !message.is_archived
      )
      .map((message) => message.id);
    const candidateIds = new Set(orderedCandidateIds);
    const intersectingIds = new Set<string>();
    const confirmedIds = new Set<string>();
    const visibilityTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollStopTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingMessageId: string | null = null;
    let disposed = false;
    let acknowledgedThroughIndex = lastMarkedRef.current
      ? orderedCandidateIds.indexOf(lastMarkedRef.current)
      : -1;

    function clearVisibilityTimer(messageId: string) {
      const timer = visibilityTimers.get(messageId);
      if (timer) clearTimeout(timer);
      visibilityTimers.delete(messageId);
    }

    function clearPendingVisibility() {
      for (const timer of visibilityTimers.values()) clearTimeout(timer);
      visibilityTimers.clear();
      confirmedIds.clear();
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (scrollStopTimer) clearTimeout(scrollStopTimer);
      scrollStopTimer = null;
    }

    function startVisibilityTimer(messageId: string) {
      const messageIndex = orderedCandidateIds.indexOf(messageId);
      if (
        messageIndex <= acknowledgedThroughIndex ||
        !readWindowActivity().isActive ||
        !intersectingIds.has(messageId) ||
        confirmedIds.has(messageId) ||
        visibilityTimers.has(messageId)
      ) return;
      visibilityTimers.set(
        messageId,
        setTimeout(() => {
          visibilityTimers.delete(messageId);
          if (disposed || !readWindowActivity().isActive || !intersectingIds.has(messageId)) return;
          confirmedIds.add(messageId);
          if (!flushTimer) flushTimer = setTimeout(flushConfirmedPrefix, 0);
        }, 500)
      );
    }

    function flushConfirmedPrefix() {
      flushTimer = null;
      if (disposed || pendingMessageId || !readWindowActivity().isActive) return;
      let newestConfirmedId: string | null = null;
      for (const messageId of orderedCandidateIds.slice(acknowledgedThroughIndex + 1)) {
        if (!confirmedIds.has(messageId)) break;
        newestConfirmedId = messageId;
      }
      if (!newestConfirmedId || newestConfirmedId === lastMarkedRef.current) return;
      pendingMessageId = newestConfirmedId;
      Promise.resolve(onMarkReadRef.current?.(newestConfirmedId))
        .then((succeeded) => {
          if (disposed) return;
          if (succeeded !== false) {
            lastMarkedRef.current = newestConfirmedId;
            acknowledgedThroughIndex = orderedCandidateIds.indexOf(newestConfirmedId);
            for (let index = 0; index <= acknowledgedThroughIndex; index += 1) {
              confirmedIds.delete(orderedCandidateIds[index]);
              clearVisibilityTimer(orderedCandidateIds[index]);
            }
          } else {
            for (const messageId of intersectingIds) {
              confirmedIds.delete(messageId);
              startVisibilityTimer(messageId);
            }
          }
        })
        .catch(() => {
          if (!disposed) {
            for (const messageId of intersectingIds) {
              confirmedIds.delete(messageId);
              startVisibilityTimer(messageId);
            }
          }
        })
        .finally(() => {
          pendingMessageId = null;
          if (!disposed) {
            if (confirmedIds.has(orderedCandidateIds[acknowledgedThroughIndex + 1])) {
              flushConfirmedPrefix();
            }
            for (const messageId of intersectingIds) startVisibilityTimer(messageId);
          }
        });
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const messageId = (entry.target as HTMLElement).dataset.messageId;
          if (!messageId || !candidateIds.has(messageId)) continue;
          if (isSufficientlyVisible(entry)) {
            intersectingIds.add(messageId);
            startVisibilityTimer(messageId);
          } else {
            intersectingIds.delete(messageId);
            confirmedIds.delete(messageId);
            clearVisibilityTimer(messageId);
          }
        }
      },
      { root, threshold: [0, 0.25, 0.5, 0.6] }
    );
    for (const element of root.querySelectorAll<HTMLElement>("[data-message-id]")) {
      if (element.dataset.messageId && candidateIds.has(element.dataset.messageId)) observer.observe(element);
    }
    const unsubscribeActivity = subscribeWindowActivity((activity) => {
      clearPendingVisibility();
      if (activity.isActive) {
        for (const messageId of intersectingIds) startVisibilityTimer(messageId);
      }
    });
    const handleScroll = () => {
      for (const timer of visibilityTimers.values()) clearTimeout(timer);
      visibilityTimers.clear();
      for (const messageId of intersectingIds) {
        if (orderedCandidateIds.indexOf(messageId) > acknowledgedThroughIndex) {
          confirmedIds.delete(messageId);
        }
      }
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (scrollStopTimer) clearTimeout(scrollStopTimer);
      scrollStopTimer = setTimeout(() => {
        scrollStopTimer = null;
        for (const messageId of intersectingIds) startVisibilityTimer(messageId);
      }, 100);
    };
    root.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      disposed = true;
      clearPendingVisibility();
      root.removeEventListener("scroll", handleScroll);
      observer.disconnect();
      unsubscribeActivity();
    };
  }, [currentUserId, messages, scrollContainerRef, unread]);
}
