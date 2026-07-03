"use client";

import { useCallback, useEffect, useState, type ClipboardEvent, type RefObject } from "react";

const CLIPBOARD_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

type ClipboardAttachmentOptions = {
  onAfterTextInsert?: (textarea: HTMLTextAreaElement) => void;
  onTextChange: (value: string) => void;
  pastedMessage: string;
  replacedMessage: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  textValue: string;
};

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

function buildClipboardFilename(contentType: string) {
  const now = new Date();
  const date = [now.getFullYear(), padDatePart(now.getMonth() + 1), padDatePart(now.getDate())].join("-");
  const time = [padDatePart(now.getHours()), padDatePart(now.getMinutes()), padDatePart(now.getSeconds())].join("");
  return `screenshot-${date}-${time}.${CLIPBOARD_IMAGE_EXTENSIONS[contentType]}`;
}

export function useClipboardAttachment({
  onAfterTextInsert,
  onTextChange,
  pastedMessage,
  replacedMessage,
  textareaRef,
  textValue
}: ClipboardAttachmentOptions) {
  const [selectedFile, setSelectedFileState] = useState<File | null>(null);
  const [isClipboardImage, setIsClipboardImage] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pasteFeedback, setPasteFeedback] = useState("");

  useEffect(() => {
    if (!selectedFile || !isClipboardImage) {
      setPreviewUrl(null);
      return;
    }

    const objectUrl = URL.createObjectURL(selectedFile);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [isClipboardImage, selectedFile]);

  const clearAttachment = useCallback(() => {
    setSelectedFileState(null);
    setIsClipboardImage(false);
    setPasteFeedback("");
  }, []);

  const selectFile = useCallback((file: File | null) => {
    setSelectedFileState(file);
    setIsClipboardImage(false);
    setPasteFeedback("");
  }, []);

  const selectDroppedFile = useCallback(
    (file: File, droppedReplacementMessage: string) => {
      setSelectedFileState(file);
      setIsClipboardImage(Boolean(CLIPBOARD_IMAGE_EXTENSIONS[file.type]));
      setPasteFeedback(selectedFile ? droppedReplacementMessage : "");
    },
    [selectedFile]
  );

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const imageItem = Array.from(event.clipboardData.items).find(
      (item) => item.kind === "file" && Boolean(CLIPBOARD_IMAGE_EXTENSIONS[item.type])
    );
    const clipboardFile = imageItem?.getAsFile();
    if (!clipboardFile || !imageItem) {
      return false;
    }

    event.preventDefault();
    const generatedFile = new File([clipboardFile], buildClipboardFilename(imageItem.type), {
      type: imageItem.type,
      lastModified: Date.now()
    });
    setPasteFeedback(selectedFile ? replacedMessage : pastedMessage);
    setSelectedFileState(generatedFile);
    setIsClipboardImage(true);

    const clipboardText = event.clipboardData.getData("text/plain");
    if (!clipboardText) {
      return true;
    }

    const textarea = textareaRef.current ?? event.currentTarget;
    const selectionStart = textarea.selectionStart ?? textValue.length;
    const selectionEnd = textarea.selectionEnd ?? selectionStart;
    const nextValue = `${textValue.slice(0, selectionStart)}${clipboardText}${textValue.slice(selectionEnd)}`;
    const nextCursorPosition = selectionStart + clipboardText.length;
    onTextChange(nextValue);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCursorPosition, nextCursorPosition);
      onAfterTextInsert?.(textarea);
    });
    return true;
  }

  return {
    clearAttachment,
    handlePaste,
    isClipboardImage,
    pasteFeedback,
    previewUrl,
    selectFile,
    selectDroppedFile,
    selectedFile
  };
}
