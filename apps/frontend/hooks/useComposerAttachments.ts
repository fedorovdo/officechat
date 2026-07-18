"use client";

import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type RefObject } from "react";

import { createClientId } from "../lib/client-id";

export const COMPOSER_MAX_FILES = 10;
export const COMPOSER_MAX_TOTAL_SIZE_BYTES = 50 * 1024 * 1024;
export const COMPOSER_ALLOWED_EXTENSIONS = [
  "txt", "log", "csv", "md", "json", "xml", "yaml", "yml", "ini", "conf",
  "pdf", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg", "webp", "zip"
] as const;
export const COMPOSER_FILE_ACCEPT = COMPOSER_ALLOWED_EXTENSIONS.map((extension) => `.${extension}`).join(",");

const ALLOWED_EXTENSION_SET = new Set<string>(COMPOSER_ALLOWED_EXTENSIONS);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
const CLIPBOARD_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

export type ComposerAttachment = {
  file: File;
  id: string;
  isImage: boolean;
  previewUrl: string | null;
};

type ComposerAttachmentsOptions = {
  emptyFileError: string;
  onAfterTextInsert?: (textarea: HTMLTextAreaElement) => void;
  onError: (message: string) => void;
  onTextChange: (value: string) => void;
  pastedMessage: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  textValue: string;
  tooManyFilesError: string;
  totalSizeError: string;
  unsupportedFileError: string;
};

function getExtension(filename: string) {
  return filename.split(".").pop()?.trim().toLowerCase() ?? "";
}

function isImageFile(file: File) {
  return IMAGE_EXTENSIONS.has(getExtension(file.name));
}

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

function buildClipboardFilename(contentType: string) {
  const now = new Date();
  const date = [now.getFullYear(), padDatePart(now.getMonth() + 1), padDatePart(now.getDate())].join("-");
  const time = [padDatePart(now.getHours()), padDatePart(now.getMinutes()), padDatePart(now.getSeconds())].join("");
  return `screenshot-${date}-${time}.${CLIPBOARD_IMAGE_EXTENSIONS[contentType]}`;
}

function releaseAttachment(attachment: ComposerAttachment) {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

export function useComposerAttachments({
  emptyFileError,
  onAfterTextInsert,
  onError,
  onTextChange,
  pastedMessage,
  textareaRef,
  textValue,
  tooManyFilesError,
  totalSizeError,
  unsupportedFileError
}: ComposerAttachmentsOptions) {
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [feedback, setFeedback] = useState("");

  const replaceAttachments = useCallback((next: ComposerAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const clearAttachments = useCallback(() => {
    attachmentsRef.current.forEach(releaseAttachment);
    replaceAttachments([]);
    setFeedback("");
  }, [replaceAttachments]);

  useEffect(() => () => attachmentsRef.current.forEach(releaseAttachment), []);

  const appendFiles = useCallback(
    (files: File[], nextFeedback = "") => {
      if (files.length === 0) return false;
      if (files.some((file) => file.size === 0)) {
        onError(emptyFileError);
        return false;
      }
      if (files.some((file) => !ALLOWED_EXTENSION_SET.has(getExtension(file.name)))) {
        onError(unsupportedFileError);
        return false;
      }

      const current = attachmentsRef.current;
      if (current.length + files.length > COMPOSER_MAX_FILES) {
        onError(tooManyFilesError);
        return false;
      }
      const nextTotalSize = current.reduce((total, item) => total + item.file.size, 0)
        + files.reduce((total, file) => total + file.size, 0);
      if (nextTotalSize > COMPOSER_MAX_TOTAL_SIZE_BYTES) {
        onError(totalSizeError);
        return false;
      }

      const additions = files.map((file) => {
        const image = isImageFile(file);
        return {
          file,
          id: createClientId(),
          isImage: image,
          previewUrl: image ? URL.createObjectURL(file) : null
        };
      });
      replaceAttachments([...current, ...additions]);
      setFeedback(nextFeedback);
      onError("");
      return true;
    },
    [emptyFileError, onError, replaceAttachments, tooManyFilesError, totalSizeError, unsupportedFileError]
  );

  const removeAttachment = useCallback(
    (id: string) => {
      const item = attachmentsRef.current.find((attachment) => attachment.id === id);
      if (item) releaseAttachment(item);
      replaceAttachments(attachmentsRef.current.filter((attachment) => attachment.id !== id));
      setFeedback("");
    },
    [replaceAttachments]
  );

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const imageItem = Array.from(event.clipboardData.items).find(
      (item) => item.kind === "file" && Boolean(CLIPBOARD_IMAGE_EXTENSIONS[item.type])
    );
    const clipboardFile = imageItem?.getAsFile();
    if (!clipboardFile || !imageItem) return false;

    event.preventDefault();
    const generatedFile = new File([clipboardFile], buildClipboardFilename(imageItem.type), {
      type: imageItem.type,
      lastModified: Date.now()
    });
    appendFiles([generatedFile], pastedMessage);

    const clipboardText = event.clipboardData.getData("text/plain");
    if (!clipboardText) return true;

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
    appendFiles,
    attachments,
    clearAttachments,
    feedback,
    handlePaste,
    removeAttachment,
    selectedFiles: attachments.map((attachment) => attachment.file),
    totalSize: attachments.reduce((total, attachment) => total + attachment.file.size, 0)
  };
}
