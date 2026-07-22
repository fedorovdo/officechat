"use client";

import { useEffect } from "react";

import { clearAppBadge, updateAppBadge } from "./appBadge";

export function useAppBadge(totalUnread: number, authenticated: boolean | null) {
  useEffect(() => {
    if (authenticated === null) return;
    if (!authenticated) {
      void clearAppBadge();
      return;
    }
    void updateAppBadge(totalUnread);
  }, [authenticated, totalUnread]);
}
