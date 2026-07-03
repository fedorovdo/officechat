"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";

type DropFileItem = DataTransferItem & {
  webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
};

type DragDropAttachmentOptions = {
  emptyFileError: string;
  failedReadError: string;
  folderError: string;
  onDropFiles: (files: File[]) => void;
  onError: (message: string) => void;
};

function containsFiles(types: readonly string[] | DOMStringList) {
  return Array.from(types).includes("Files");
}

export function useDragDropAttachment({
  emptyFileError,
  failedReadError,
  folderError,
  onDropFiles,
  onError
}: DragDropAttachmentOptions) {
  const dragDepthRef = useRef(0);
  const [isFileDragging, setIsFileDragging] = useState(false);

  const resetDragState = useCallback(() => {
    dragDepthRef.current = 0;
    setIsFileDragging(false);
  }, []);

  useEffect(() => {
    function preventFileNavigation(event: DragEvent) {
      if (!containsFiles(event.dataTransfer?.types ?? [])) return;
      event.preventDefault();
      if (event.type === "drop") resetDragState();
    }

    function handleGlobalDragEnd() {
      resetDragState();
    }

    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    window.addEventListener("dragend", handleGlobalDragEnd);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
      window.removeEventListener("dragend", handleGlobalDragEnd);
    };
  }, [resetDragState]);

  function handleDragEnter(event: ReactDragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsFileDragging(true);
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (dragDepthRef.current === 0) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsFileDragging(false);
  }

  function handleDrop(event: ReactDragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    resetDragState();

    const fileItems = Array.from(event.dataTransfer.items).filter((item) => item.kind === "file") as DropFileItem[];
    if (fileItems.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      onError(folderError);
      return;
    }

    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) {
      onError(failedReadError);
      return;
    }
    if (files.some((file) => file.size === 0)) {
      onError(emptyFileError);
      return;
    }

    onDropFiles(files);
  }

  return {
    dropZoneProps: {
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDragOver: handleDragOver,
      onDrop: handleDrop
    },
    isFileDragging
  };
}
