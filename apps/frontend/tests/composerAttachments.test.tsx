import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerAttachments } from "../hooks/useComposerAttachments";

function renderAttachmentsHook() {
  const onError = vi.fn();
  const onTextChange = vi.fn();
  const textareaRef = createRef<HTMLTextAreaElement>();
  const hook = renderHook(() => useComposerAttachments({
    emptyFileError: "empty",
    onError,
    onTextChange,
    pastedMessage: "pasted",
    textareaRef,
    textValue: "",
    tooManyFilesError: "too many",
    totalSizeError: "too large",
    unsupportedFileError: "unsupported"
  }));
  return { ...hook, onError, onTextChange };
}

beforeEach(() => {
  let entropySeed = 0;
  vi.stubGlobal("crypto", {
    getRandomValues: (bytes: Uint8Array) => {
      entropySeed += 1;
      bytes.forEach((_, index) => { bytes[index] = (index + entropySeed) & 0xff; });
      return bytes;
    }
  });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useComposerAttachments without crypto.randomUUID", () => {
  it("adds multiple files, supports repeat selection, and removes by generated ID", () => {
    const { result } = renderAttachmentsHook();
    const first = new File(["one"], "one.txt", { type: "text/plain" });
    const second = new File(["two"], "two.txt", { type: "text/plain" });

    act(() => { result.current.appendFiles([first, second]); });
    expect(result.current.selectedFiles).toEqual([first, second]);
    expect(new Set(result.current.attachments.map((item) => item.id)).size).toBe(2);

    act(() => { result.current.appendFiles([first]); });
    expect(result.current.selectedFiles).toEqual([first, second, first]);

    const removedId = result.current.attachments[1].id;
    act(() => { result.current.removeAttachment(removedId); });
    expect(result.current.selectedFiles).toEqual([first, first]);
  });

  it("adds a pasted screenshot without relying on randomUUID", () => {
    const { result } = renderAttachmentsHook();
    const clipboardImage = new File(["image"], "clipboard.png", { type: "image/png" });
    const preventDefault = vi.fn();
    const event = {
      clipboardData: {
        getData: vi.fn(() => ""),
        items: [{ kind: "file", type: "image/png", getAsFile: () => clipboardImage }]
      },
      currentTarget: document.createElement("textarea"),
      preventDefault
    } as unknown as React.ClipboardEvent<HTMLTextAreaElement>;

    act(() => { result.current.handlePaste(event); });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0].file.name).toMatch(/^screenshot-.*\.png$/);
    expect(result.current.attachments[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("clears all selected files after a successful-send style reset", () => {
    const { result } = renderAttachmentsHook();
    act(() => { result.current.appendFiles([new File(["one"], "one.txt")]); });

    act(() => { result.current.clearAttachments(); });

    expect(result.current.attachments).toEqual([]);
    expect(result.current.selectedFiles).toEqual([]);
  });
});
