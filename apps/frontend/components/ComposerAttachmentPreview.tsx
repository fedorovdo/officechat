"use client";

import type { Dictionary } from "../lib/i18n";
import { formatFileSize } from "../lib/files";

type ComposerAttachmentPreviewProps = {
  dictionary: Dictionary;
  file: File;
  isClipboardImage: boolean;
  onRemove: () => void;
  pasteFeedback: string;
  previewUrl: string | null;
};

export function ComposerAttachmentPreview({
  dictionary,
  file,
  isClipboardImage,
  onRemove,
  pasteFeedback,
  previewUrl
}: ComposerAttachmentPreviewProps) {
  return (
    <div className={`selected-attachment${isClipboardImage ? " selected-attachment-image" : ""}`}>
      {previewUrl ? <img alt={file.name} className="selected-attachment-thumbnail" src={previewUrl} /> : null}
      <span className="selected-attachment-details">
        <strong>{file.name}</strong>
        {isClipboardImage ? <small>{formatFileSize(file.size)}</small> : null}
        {pasteFeedback ? <small className="selected-attachment-feedback">{pasteFeedback}</small> : null}
      </span>
      <button
        aria-label={isClipboardImage ? dictionary.messages.removeClipboardImage : dictionary.appShell.removeAttachment}
        className="table-action"
        onClick={onRemove}
        title={isClipboardImage ? dictionary.messages.removeClipboardImage : dictionary.appShell.removeAttachment}
        type="button"
      >
        ×
      </button>
    </div>
  );
}
