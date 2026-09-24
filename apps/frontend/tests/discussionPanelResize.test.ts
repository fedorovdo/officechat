import { describe, expect, it } from "vitest";

import {
  clampDiscussionPanelWidth,
  defaultDiscussionWidth,
  getDiscussionResizeDirection,
  getDiscussionResizeKeyboardDelta,
  maximumDiscussionWidth,
  minimumDiscussionWidth
} from "../lib/discussionPanelResize";

describe("discussion panel resize", () => {
  it("clamps the preferred width to its absolute bounds", () => {
    expect(clampDiscussionPanelWidth(200)).toBe(minimumDiscussionWidth);
    expect(clampDiscussionPanelWidth(900)).toBe(maximumDiscussionWidth);
    expect(clampDiscussionPanelWidth(Number.NaN)).toBe(defaultDiscussionWidth);
  });

  it("preserves enough room for the primary chat", () => {
    expect(clampDiscussionPanelWidth(700, 1000)).toBe(574);
    expect(clampDiscussionPanelWidth(700, 600)).toBe(minimumDiscussionWidth);
  });

  it("uses the separator movement direction for either sidebar side", () => {
    expect(getDiscussionResizeDirection("left")).toBe(-1);
    expect(getDiscussionResizeDirection("right")).toBe(1);
  });

  it("maps keyboard arrows to the visible separator direction", () => {
    expect(getDiscussionResizeKeyboardDelta("ArrowRight", "left")).toBe(-16);
    expect(getDiscussionResizeKeyboardDelta("ArrowLeft", "left")).toBe(16);
    expect(getDiscussionResizeKeyboardDelta("ArrowRight", "right")).toBe(16);
    expect(getDiscussionResizeKeyboardDelta("Enter", "right")).toBe(0);
  });
});
