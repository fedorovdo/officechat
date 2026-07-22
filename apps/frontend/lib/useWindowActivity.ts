"use client";

import { useEffect, useState } from "react";

export type WindowActivity = {
  visibilityState: DocumentVisibilityState | "unknown";
  hidden: boolean;
  hasFocus: boolean;
  isActive: boolean;
};

export function readWindowActivity(): WindowActivity {
  if (typeof document === "undefined") {
    return { visibilityState: "unknown", hidden: true, hasFocus: false, isActive: false };
  }
  const visibilityState = document.visibilityState;
  const hidden = document.hidden;
  const hasFocus = document.hasFocus();
  return {
    visibilityState,
    hidden,
    hasFocus,
    isActive: visibilityState === "visible" && hasFocus
  };
}

export function subscribeWindowActivity(listener: (activity: WindowActivity) => void) {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  const update = () => listener(readWindowActivity());
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    document.removeEventListener("visibilitychange", update);
  };
}

export function useWindowActivity() {
  const [activity, setActivity] = useState<WindowActivity>(() => readWindowActivity());
  useEffect(() => {
    setActivity(readWindowActivity());
    return subscribeWindowActivity(setActivity);
  }, []);
  return activity;
}
