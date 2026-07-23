"use client";

import { useState } from "react";

import type { LegacyUnreadRepairResult } from "../lib/api";
import type { Dictionary } from "../lib/i18n";

type LegacyUnreadRepairControlProps = {
  dictionary: Dictionary;
  onRepair: () => Promise<LegacyUnreadRepairResult>;
};

export function LegacyUnreadRepairControl({
  dictionary,
  onRepair
}: LegacyUnreadRepairControlProps) {
  const [isPending, setIsPending] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  async function handleRepair() {
    if (!window.confirm(dictionary.unread.legacyRepairConfirmation)) return;
    setIsPending(true);
    setSuccess("");
    setError("");
    try {
      const result = await onRepair();
      setSuccess(
        dictionary.unread.legacyRepairSuccess
          .replace("{messages}", String(result.cleared_messages))
          .replace("{chats}", String(result.cleared_chats))
      );
    } catch {
      setError(dictionary.unread.legacyRepairError);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="legacy-unread-repair">
      <span className="field-label">
        {dictionary.unread.legacyRepairTitle}
      </span>
      <p className="note">{dictionary.unread.legacyRepairDescription}</p>
      <button
        className="secondary-link"
        disabled={isPending}
        onClick={() => void handleRepair()}
        type="button"
      >
        {isPending
          ? dictionary.unread.legacyRepairPending
          : dictionary.unread.legacyRepairAction}
      </button>
      {success ? <p className="form-success" role="status">{success}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
  );
}
