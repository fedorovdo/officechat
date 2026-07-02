"use client";

import type { OfficeChatAttachment } from "../lib/api";
import type { Dictionary } from "../lib/i18n";
import { MessageAttachmentPreview } from "./MessageAttachmentPreview";

type MessageAttachmentsProps = {
  attachments: OfficeChatAttachment[];
  dictionary: Dictionary;
  onDownload: (downloadUrl: string, filename: string) => void;
};

export function getAttachmentUploadError(caughtError: unknown, dictionary: Dictionary) {
  if (!(caughtError instanceof Error)) return dictionary.messages.uploadError;
  const normalizedMessage = caughtError.message.toLowerCase();
  if (normalizedMessage.includes("exceeds") || normalizedMessage.includes("too large")) {
    return dictionary.messages.fileTooLarge;
  }
  if (normalizedMessage.includes("extension") || normalizedMessage.includes("file type")) {
    return dictionary.messages.unsupportedFileType;
  }
  if (normalizedMessage.includes("empty") || normalizedMessage.includes("filename")) {
    return dictionary.messages.noFileSelected;
  }
  if (normalizedMessage === "failed to fetch" || caughtError.name === "AbortError") {
    return dictionary.messages.uploadError;
  }
  return caughtError.message || dictionary.messages.uploadError;
}

export function MessageAttachments({ attachments, dictionary, onDownload }: MessageAttachmentsProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="attachments-list">
      {attachments.map((attachment) => (
        <MessageAttachmentPreview
          attachment={attachment}
          dictionary={dictionary}
          key={attachment.id}
          onDownload={onDownload}
        />
      ))}
    </div>
  );
}
