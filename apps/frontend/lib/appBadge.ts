type BadgingNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export async function updateAppBadge(totalUnread: number) {
  if (typeof navigator === "undefined") return false;
  const badgingNavigator = navigator as BadgingNavigator;
  const safeTotal = Number.isFinite(totalUnread) ? Math.max(0, Math.floor(totalUnread)) : 0;
  try {
    if (safeTotal > 0 && badgingNavigator.setAppBadge) {
      await badgingNavigator.setAppBadge(safeTotal);
      return true;
    }
    if (safeTotal === 0 && badgingNavigator.clearAppBadge) {
      await badgingNavigator.clearAppBadge();
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function clearAppBadge() {
  return updateAppBadge(0);
}
