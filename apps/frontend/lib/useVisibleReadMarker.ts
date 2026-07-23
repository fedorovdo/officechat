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

export function scrollUnreadMessageIntoView(
  scrollContainer: HTMLElement | null,
  messageId: string | null | undefined
) {
  if (!scrollContainer || !messageId) return false;
  const message = Array.from(
    scrollContainer.querySelectorAll<HTMLElement>("[data-message-id]")
  ).find((element) => element.dataset.messageId === messageId);
  if (!message) return false;
  message.scrollIntoView({ block: "center" });
  return true;
}

function isSufficientlyVisible(entry: IntersectionObserverEntry) {
  if (!entry.isIntersecting) return false;
  if (entry.intersectionRatio >= 0.6) return true;
  const rootHeight = entry.rootBounds?.height ?? 0;
  const messageHeight = entry.boundingClientRect.height;
  return messageHeight > rootHeight && rootHeight > 0 && entry.intersectionRect.height >= rootHeight * 0.6;
}

export function useVisibleReadMarker({ currentUserId, messages, onMarkRead, scrollContainerRef, unread }: VisibleReadMarkerOptions) {
  const lastMarkedRef = useRef<string | null>(null);
  const onMarkReadRef = useRef(onMarkRead);
  onMarkReadRef.current = onMarkRead;

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
    let pendingMessageId: string | null = null;
    let disposed = false;

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
    }

    function startVisibilityTimer(messageId: string) {
      if (
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
      for (const messageId of orderedCandidateIds) {
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
      { root, threshold: [0, 0.6] }
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
    return () => {
      disposed = true;
      clearPendingVisibility();
      observer.disconnect();
      unsubscribeActivity();
    };
  }, [currentUserId, messages, scrollContainerRef, unread]);
}
