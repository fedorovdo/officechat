export function formatFileSize(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  if (sizeBytes < 1024 * 1024 * 1024 * 1024) return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${(sizeBytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB`;
}
