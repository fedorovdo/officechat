import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LegacyUnreadRepairControl } from "../components/LegacyUnreadRepairControl";
import en from "../dictionaries/en.json";
import ru from "../dictionaries/ru.json";
import type { LegacyUnreadRepairResult } from "../lib/api";
import { unreadFactory } from "./factories";

function repairResult(
  overrides: Partial<LegacyUnreadRepairResult> = {}
): LegacyUnreadRepairResult {
  return {
    cleared_messages: 15,
    cleared_chats: 3,
    unread: unreadFactory({
      total: 0,
      groups: 0,
      direct: 0,
      discussions: 0,
      chats: []
    }),
    notification_unread_count: 4,
    read_notifications: 4,
    ...overrides
  };
}

describe("legacy unread repair control", () => {
  it("requires confirmation and cancel does not call the API", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onRepair = vi.fn();
    render(<LegacyUnreadRepairControl dictionary={en} onRepair={onRepair} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Clear legacy unread messages" })
    );

    expect(confirm).toHaveBeenCalledWith(en.unread.legacyRepairConfirmation);
    expect(onRepair).not.toHaveBeenCalled();
  });

  it("uses the localized Russian confirmation and action text", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<LegacyUnreadRepairControl dictionary={ru} onRepair={vi.fn()} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Исправить старые непрочитанные" })
    );

    expect(confirm).toHaveBeenCalledWith(ru.unread.legacyRepairConfirmation);
  });

  it("disables the action while pending and reports authoritative counts", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let resolveRepair!: (result: LegacyUnreadRepairResult) => void;
    const onRepair = vi.fn(
      () => new Promise<LegacyUnreadRepairResult>((resolve) => {
        resolveRepair = resolve;
      })
    );
    render(<LegacyUnreadRepairControl dictionary={en} onRepair={onRepair} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Clear legacy unread messages" })
    );
    expect(
      screen.getByRole("button", {
        name: "Clearing legacy unread messages..."
      })
    ).toBeDisabled();

    resolveRepair(repairResult());
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Legacy unread cleared: 15 messages in 3 chats."
    );
    expect(
      screen.getByRole("button", { name: "Clear legacy unread messages" })
    ).toBeEnabled();
  });

  it("reports zero changes on an idempotent repeated run", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onRepair = vi.fn().mockResolvedValue(
      repairResult({ cleared_messages: 0, cleared_chats: 0 })
    );
    render(<LegacyUnreadRepairControl dictionary={en} onRepair={onRepair} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Clear legacy unread messages" })
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Legacy unread cleared: 0 messages in 0 chats."
    );
  });

  it("shows an error without reporting optimistic success", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onRepair = vi.fn().mockRejectedValue(new Error("Unavailable"));
    render(<LegacyUnreadRepairControl dictionary={en} onRepair={onRepair} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Clear legacy unread messages" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not clear legacy unread messages."
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
