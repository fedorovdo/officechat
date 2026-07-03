"use client";

import type { ComposerAttachment } from "../hooks/useComposerAttachments";
import { formatFileSize } from "../lib/files";
import type { Dictionary } from "../lib/i18n";

type ComposerAttachmentsPreviewProps = {
  attachments: ComposerAttachment[];
  dictionary: Dictionary;
  feedback: string;
  onClear: () => void;
  onRemove: (id: string) => void;
  totalSize: number;
};

export function ComposerAttachmentsPreview({
  attachments,
  dictionary,
  feedback,
  onClear,
  onRemove,
  totalSize
}: ComposerAttachmentsPreviewProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="composer-attachments">
      <div className="composer-attachments-summary">
        <span>
          {dictionary.messages.filesSelected.replace("{count}", String(attachments.length))}
          {" · "}{formatFileSize(totalSize)}
        </span>
        <button className="table-action" onClick={onClear} type="button">
          {dictionary.messages.clearAllAttachments}
        </button>
      </div>
      <div className="composer-attachments-list">
        {attachments.map((attachment) => (
          <div className="selected-attachment" key={attachment.id}>
            {attachment.previewUrl ? (
              <img alt={attachment.file.name} className="selected-attachment-thumbnail" src={attachment.previewUrl} />
            ) : (
              <span aria-hidden="true" className="selected-attachment-file-icon">+</span>
            )}
            <span className="selected-attachment-details">
              <strong>{attachment.file.name}</strong>
              <small>{formatFileSize(attachment.file.size)}</small>
            </span>
            <button
              aria-label={dictionary.messages.removeFile}
              className="table-action"
              onClick={() => onRemove(attachment.id)}
              title={dictionary.messages.removeFile}
              type="button"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {feedback ? <small className="selected-attachment-feedback">{feedback}</small> : null}
    </div>
  );
}
