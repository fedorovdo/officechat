import { describe, expect, it, vi } from "vitest";

import { loadInitialMessageWindow, mergeMessageWindow } from "../lib/messagePagination";

function page(first: number, last: number) {
  return Array.from({ length: last - first + 1 }, (_, index) => ({
    id: `message-${first + index}`
  }));
}

describe("initial message pagination", () => {
  it("loads older pages until the exact first unread message is present", async () => {
    const loadPage = vi.fn(async (_limit: number, before?: string) => {
      if (!before) return page(51, 100);
      if (before === "message-51") return page(1, 50);
      return [];
    });

    const result = await loadInitialMessageWindow(loadPage, "message-20");

    expect(result.targetFound).toBe(true);
    expect(result.messages).toHaveLength(100);
    expect(result.messages[19]?.id).toBe("message-20");
    expect(loadPage).toHaveBeenNthCalledWith(2, 50, "message-51");
  });

  it("uses the latest page when there is no unread target", async () => {
    const loadPage = vi.fn(async () => page(51, 100));

    const result = await loadInitialMessageWindow(loadPage, null);

    expect(result).toEqual({ messages: page(51, 100), targetFound: false });
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("falls back to the latest page after the bounded lookup is exhausted", async () => {
    const loadPage = vi.fn(async (_limit: number, before?: string) => {
      const upper = before ? Number(before.replace("message-", "")) - 1 : 500;
      return page(upper - 49, upper);
    });

    const result = await loadInitialMessageWindow(loadPage, "message-not-loaded");

    expect(result.targetFound).toBe(false);
    expect(result.messages).toEqual(page(451, 500));
    expect(loadPage).toHaveBeenCalledTimes(8);
  });

  it("stops when the backend repeats the same pagination cursor", async () => {
    const repeatedPage = page(1, 50);
    const loadPage = vi.fn(async () => repeatedPage);

    const result = await loadInitialMessageWindow(loadPage, "message-not-loaded");

    expect(result).toEqual({ messages: repeatedPage, targetFound: false });
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("aborts before requesting another page", async () => {
    const abortController = new AbortController();
    const loadPage = vi.fn(async (_limit: number, before?: string) => {
      if (before) throw new Error("An older page must not be requested after abort");
      abortController.abort();
      return page(51, 100);
    });

    await expect(
      loadInitialMessageWindow(loadPage, "message-not-loaded", abortController.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("preserves the loaded unread window while applying live message updates", () => {
    expect(mergeMessageWindow(
      [{ id: "message-old" }, { id: "message-current", body: "before" }],
      [{ id: "message-current", body: "after" }, { id: "message-new" }]
    )).toEqual([
      { id: "message-old" },
      { id: "message-current", body: "after" },
      { id: "message-new" }
    ]);
  });
});
