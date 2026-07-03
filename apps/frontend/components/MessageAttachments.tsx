"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { downloadAttachment, getStoredAccessToken, type OfficeChatAttachment } from "../lib/api";
import { formatFileSize } from "../lib/files";
import type { Dictionary } from "../lib/i18n";

const PREVIEWABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PREVIEWABLE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

type MessageAttachmentsProps = {
  attachments: OfficeChatAttachment[];
  dictionary: Dictionary;
  onDownload: (downloadUrl: string, filename: string) => void;
};

function isPreviewableImage(attachment: OfficeChatAttachment) {
  const contentType = (attachment.content_type ?? "").split(";", 1)[0].trim().toLowerCase();
  const extension = attachment.original_filename.split(".").pop()?.toLowerCase() ?? "";
  return PREVIEWABLE_IMAGE_TYPES.has(contentType) || PREVIEWABLE_IMAGE_EXTENSIONS.has(extension);
}

export function getAttachmentUploadError(caughtError: unknown, dictionary: Dictionary) {
  if (!(caughtError instanceof Error)) return dictionary.messages.uploadError;
  const normalizedMessage = caughtError.message.toLowerCase();
  if (normalizedMessage.includes("at most") || normalizedMessage.includes("too many")) {
    return dictionary.messages.tooManyFiles;
  }
  if (normalizedMessage.includes("total attachment size")) {
    return dictionary.messages.totalAttachmentSizeTooLarge;
  }
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [shouldLoadImages, setShouldLoadImages] = useState(false);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const images = useMemo(
    () => attachments.filter((attachment) => attachment.file_available && isPreviewableImage(attachment)),
    [attachments]
  );
  const files = useMemo(
    () => attachments.filter((attachment) => attachment.file_available && !isPreviewableImage(attachment)),
    [attachments]
  );
  const unavailableFiles = useMemo(
    () => attachments.filter((attachment) => !attachment.file_available),
    [attachments]
  );

  useEffect(() => {
    if (images.length === 0) return;
    const container = containerRef.current;
    if (!container || typeof IntersectionObserver === "undefined") {
      setShouldLoadImages(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoadImages(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" }
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [images.length]);

  useEffect(() => {
    if (!shouldLoadImages || images.length === 0) return;
    const token = getStoredAccessToken();
    if (!token) return;
    let cancelled = false;
    const createdUrls: string[] = [];

    void Promise.all(
      images.map(async (attachment) => {
        try {
          const blob = await downloadAttachment(token, attachment.download_url);
          if (cancelled) return;
          const objectUrl = URL.createObjectURL(blob);
          createdUrls.push(objectUrl);
          setImageUrls((current) => ({ ...current, [attachment.id]: objectUrl }));
        } catch {
          if (!cancelled) setImageUrls((current) => ({ ...current, [attachment.id]: "" }));
        }
      })
    );

    return () => {
      cancelled = true;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
      setImageUrls({});
    };
  }, [images, shouldLoadImages]);

  useEffect(() => {
    if (lightboxIndex === null) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setLightboxIndex(null);
      if (event.key === "ArrowLeft") {
        setLightboxIndex((current) => current === null ? null : (current - 1 + images.length) % images.length);
      }
      if (event.key === "ArrowRight") {
        setLightboxIndex((current) => current === null ? null : (current + 1) % images.length);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [images.length, lightboxIndex]);

  if (attachments.length === 0) return null;
  const activeImage = lightboxIndex === null ? null : images[lightboxIndex];

  return (
    <div className="attachments-list" ref={containerRef}>
      {images.length > 0 ? (
        <div className={`message-image-gallery message-image-gallery-${Math.min(images.length, 4)}`}>
          {images.map((attachment, index) => {
            const previewUrl = imageUrls[attachment.id];
            return (
              <button
                aria-label={`${dictionary.messages.openImage}: ${attachment.original_filename}`}
                className="message-image-gallery-item"
                disabled={!previewUrl}
                key={attachment.id}
                onClick={() => setLightboxIndex(index)}
                title={attachment.original_filename}
                type="button"
              >
                {previewUrl ? (
                  <img alt={attachment.original_filename} loading="lazy" src={previewUrl} />
                ) : (
                  <span>{imageUrls[attachment.id] === "" ? dictionary.messages.imagePreviewError : dictionary.messages.loadingImage}</span>
                )}
              </button>
            );
          })}
        </div>
      ) : null}

      {files.length > 0 ? (
        <div className="message-file-list">
          {files.map((attachment) => (
            <button
              className="attachment-button"
              key={attachment.id}
              onClick={() => onDownload(attachment.download_url, attachment.original_filename)}
              title={dictionary.messages.downloadOriginal}
              type="button"
            >
              <span>{attachment.original_filename}</span>
              <span>{formatFileSize(attachment.size_bytes)}</span>
              <span>{dictionary.messages.download}</span>
            </button>
          ))}
        </div>
      ) : null}

      {unavailableFiles.length > 0 ? (
        <div className="message-file-list">
          {unavailableFiles.map((attachment) => (
            <div className="attachment-button attachment-button-unavailable" key={attachment.id}>
              <span>{attachment.original_filename}</span>
              <span>{formatFileSize(attachment.size_bytes)}</span>
              <span>{dictionary.retention.fileRemoved}</span>
            </div>
          ))}
        </div>
      ) : null}

      {activeImage && imageUrls[activeImage.id] ? (
        <div
          aria-label={dictionary.messages.imageAttachment}
          aria-modal="true"
          className="image-lightbox"
          onClick={(event) => {
            if (event.currentTarget === event.target) setLightboxIndex(null);
          }}
          role="dialog"
        >
          <div className="image-lightbox-content">
            <div className="image-lightbox-toolbar">
              <span>
                <strong>{activeImage.original_filename}</strong>
                <small>{dictionary.messages.imageOf
                  .replace("{current}", String(lightboxIndex! + 1))
                  .replace("{total}", String(images.length))}</small>
              </span>
              <div className="image-lightbox-actions">
                <button className="secondary-link" onClick={() => onDownload(activeImage.download_url, activeImage.original_filename)} type="button">
                  {dictionary.messages.downloadOriginal}
                </button>
                <button aria-label={dictionary.messages.closeImage} className="secondary-link" onClick={() => setLightboxIndex(null)} type="button">×</button>
              </div>
            </div>
            {images.length > 1 ? (
              <button
                aria-label={dictionary.messages.previousImage}
                className="image-lightbox-navigation image-lightbox-previous"
                onClick={() => setLightboxIndex((lightboxIndex! - 1 + images.length) % images.length)}
                type="button"
              >
                ‹
              </button>
            ) : null}
            <img alt={activeImage.original_filename} className="image-lightbox-image" src={imageUrls[activeImage.id]} />
            {images.length > 1 ? (
              <button
                aria-label={dictionary.messages.nextImage}
                className="image-lightbox-navigation image-lightbox-next"
                onClick={() => setLightboxIndex((lightboxIndex! + 1) % images.length)}
                type="button"
              >
                ›
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
