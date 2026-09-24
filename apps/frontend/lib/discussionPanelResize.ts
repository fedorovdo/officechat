export const discussionWidthKey = "officechat.discussion.width";
export const defaultDiscussionWidth = 480;
export const minimumDiscussionWidth = 360;
export const maximumDiscussionWidth = 720;

const minimumPrimaryChatWidth = 420;
const discussionResizeHandleWidth = 6;
const keyboardResizeStep = 16;

export type SidebarSide = "left" | "right";

export function getMaximumDiscussionWidth(containerWidth = 0) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return maximumDiscussionWidth;
  }

  const availableWidth =
    containerWidth - minimumPrimaryChatWidth - discussionResizeHandleWidth;

  return Math.max(
    minimumDiscussionWidth,
    Math.min(maximumDiscussionWidth, Math.floor(availableWidth))
  );
}

export function clampDiscussionPanelWidth(
  requestedWidth: number,
  containerWidth = 0
) {
  const safeWidth = Number.isFinite(requestedWidth)
    ? requestedWidth
    : defaultDiscussionWidth;
  const effectiveMaximum = getMaximumDiscussionWidth(containerWidth);

  return Math.round(
    Math.min(
      effectiveMaximum,
      Math.max(minimumDiscussionWidth, safeWidth)
    )
  );
}

export function getDiscussionResizeDirection(sidebarSide: SidebarSide) {
  return sidebarSide === "right" ? 1 : -1;
}

export function getDiscussionResizeKeyboardDelta(
  key: string,
  sidebarSide: SidebarSide
) {
  if (key !== "ArrowLeft" && key !== "ArrowRight") {
    return 0;
  }

  const separatorDelta = key === "ArrowRight"
    ? keyboardResizeStep
    : -keyboardResizeStep;

  return separatorDelta * getDiscussionResizeDirection(sidebarSide);
}