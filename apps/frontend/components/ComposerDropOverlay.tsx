"use client";

import type { Dictionary } from "../lib/i18n";

type ComposerDropOverlayProps = {
  dictionary: Dictionary;
  visible: boolean;
};

export function ComposerDropOverlay({ dictionary, visible }: ComposerDropOverlayProps) {
  if (!visible) return null;
  return (
    <div aria-hidden="true" className="composer-drop-overlay">
      <span className="composer-drop-icon">📎</span>
      <strong>{dictionary.messages.dropFilesHere}</strong>
      <span>{dictionary.messages.dropFileDescription}</span>
      <small>{dictionary.messages.upToFiles.replace("{count}", "10")}</small>
    </div>
  );
}
