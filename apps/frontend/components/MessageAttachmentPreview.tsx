"use client";

import { useEffect, useRef, useState } from "react";

import { downloadAttachment, getStoredAccessToken, type OfficeChatAttachment } from "../lib/api";
import { formatFileSize } from "../lib/files";
import type { Dictionary } from "../lib/i18n";

const PREVIEWABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

type PreviewStatus = "idle" | "loading" | "ready" | "error";

type MessageAttachmentPreviewProps = {
  attachment: OfficeChatAttachment;
  dictionary: Dictionary;
  onDownload: (downloadUrl: string, filename: string) => void;
};

function normalizeContentType(contentType: string | null | undefined) {
  return (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
}

export function MessageAttachmentPreview({
  attachment,
  dictionary,
  onDownload
}: MessageAttachmentPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const isPreviewableImage = PREVIEWABLE_IMAGE_TYPES.has(normalizeContentType(attachment.content_type));

  useEffect(() => {
    if (!isPreviewableImage) return;
    const container = containerRef.current;
    if (!container || typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" }
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [attachment.id, isPreviewableImage]);

  useEffect(() => {
    if (!isPreviewableImage || !shouldLoad) return;
    const token = getStoredAccessToken();
    if (!token) {
      setPreviewStatus("error");
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setPreviewStatus("loading");
    setPreviewUrl(null);
    void downloadAttachment(token, attachment.download_url)
      .then((blob) => {
        if (!PREVIEWABLE_IMAGE_TYPES.has(normalizeContentType(blob.type))) {
          throw new Error("Unsupported image preview type");
        }
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
        setPreviewStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setPreviewStatus("error");
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.download_url, attachment.id, isPreviewableImage, shouldLoad]);

  useEffect(() => {
    if (!isLightboxOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsLightboxOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isLightboxOpen]);

  const fileRow = (
    <button
      className="attachment-button"
      onClick={() => onDownload(attachment.download_url, attachment.original_filename)}
      title={dictionary.messages.downloadOriginal}
      type="button"
    >
      <span>{attachment.original_filename}</span>
      <span>{formatFileSize(attachment.size_bytes)}</span>
      <span>{dictionary.messages.download}</span>
    </button>
  );

  if (!isPreviewableImage) return fileRow;

  return (
    <div className="message-image-attachment" ref={containerRef}>
      {previewStatus === "loading" || previewStatus === "idle" ? (
        <div className="message-image-placeholder">{dictionary.messages.loadingImage}</div>
      ) : null}
      {previewStatus === "error" ? (
        <div className="message-image-preview-error">{dictionary.messages.imagePreviewError}</div>
      ) : null}
      {previewStatus === "ready" && previewUrl ? (
        <button
          aria-label={`${dictionary.messages.openImage}: ${attachment.original_filename}`}
          className="message-image-preview-button"
          onClick={() => setIsLightboxOpen(true)}
          title={dictionary.messages.openImage}
          type="button"
        >
          <img
            alt={attachment.original_filename}
            className="message-image-preview"
            loading="lazy"
            onError={() => {
              setPreviewStatus("error");
              setPreviewUrl(null);
              setShouldLoad(false);
            }}
            src={previewUrl}
          />
        </button>
      ) : null}
      {fileRow}
      {isLightboxOpen && previewUrl ? (
        <div
          aria-label={dictionary.messages.imageAttachment}
          aria-modal="true"
          className="image-lightbox"
          onClick={(event) => {
            if (event.currentTarget === event.target) setIsLightboxOpen(false);
          }}
          role="dialog"
        >
          <div className="image-lightbox-content">
            <div className="image-lightbox-toolbar">
              <strong>{attachment.original_filename}</strong>
              <div className="image-lightbox-actions">
                <button
                  className="secondary-link"
                  onClick={() => onDownload(attachment.download_url, attachment.original_filename)}
                  title={dictionary.messages.downloadOriginal}
                  type="button"
                >
                  {dictionary.messages.downloadOriginal}
                </button>
                <button
                  aria-label={dictionary.messages.closeImage}
                  className="secondary-link"
                  onClick={() => setIsLightboxOpen(false)}
                  title={dictionary.messages.closeImage}
                  type="button"
                >
                  ×
                </button>
              </div>
            </div>
            <img alt={attachment.original_filename} className="image-lightbox-image" src={previewUrl} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
