export type FixedPopoverPlacement = "above" | "below";

export type FixedPopoverPosition = {
  left: number;
  maxHeight: number;
  placement: FixedPopoverPlacement;
  top: number;
  width: number;
};

type RectLike = Pick<DOMRect, "bottom" | "left" | "right" | "top">;

type FixedPopoverPositionOptions = {
  anchor: RectLike;
  gap?: number;
  margin?: number;
  menuHeight: number;
  menuWidth: number;
  viewportHeight: number;
  viewportWidth: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function calculateFixedPopoverPosition({
  anchor,
  gap = 8,
  margin = 10,
  menuHeight,
  menuWidth,
  viewportHeight,
  viewportWidth
}: FixedPopoverPositionOptions): FixedPopoverPosition {
  const viewportMenuWidth = Math.max(0, viewportWidth - margin * 2);
  const width = Math.min(menuWidth, viewportMenuWidth);
  const alignToLeft = (anchor.left + anchor.right) / 2 <= viewportWidth / 2;
  const preferredLeft = alignToLeft ? anchor.left : anchor.right - width;
  const left = clamp(preferredLeft, margin, viewportWidth - margin - width);
  const availableAbove = Math.max(0, anchor.top - gap - margin);
  const availableBelow = Math.max(0, viewportHeight - anchor.bottom - gap - margin);
  const placement: FixedPopoverPlacement =
    menuHeight <= availableAbove || availableAbove >= availableBelow
      ? "above"
      : "below";
  const availableHeight = placement === "above" ? availableAbove : availableBelow;
  const maxHeight = Math.min(menuHeight, availableHeight);
  const preferredTop =
    placement === "above"
      ? anchor.top - gap - maxHeight
      : anchor.bottom + gap;
  const top = clamp(
    preferredTop,
    margin,
    viewportHeight - margin - maxHeight
  );

  return {
    left: Math.round(left),
    maxHeight: Math.round(maxHeight),
    placement,
    top: Math.round(top),
    width: Math.round(width)
  };
}
