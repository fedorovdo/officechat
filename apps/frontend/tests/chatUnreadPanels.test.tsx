import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GroupChatPanel } from "../components/GroupChatPanel";
import en from "../dictionaries/en.json";
import type { OfficeChatMessage } from "../lib/api";
import { userFactory } from "./factories";

const apiMocks = vi.hoisted(() => ({
  getGroupMessages: vi.fn(),
  getPinnedMessages: vi.fn(),
  getStoredAccessToken: vi.fn(() => "test-token")
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() })
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, ...apiMocks };
});

const currentUser = userFactory({
  id: "user-current",
  display_name: "Current user",
  username: "current"
});
const sender = userFactory({
  id: "user-sender",
  display_name: "Alert sender",
  username: "alert_sender"
});

function message(overrides: Partial<OfficeChatMessage> = {}): OfficeChatMessage {
  return {
    id: "message-1",
    group_id: "group-1",
    sender_user_id: sender.id,
    reply_to_message_id: null,
    body: "Long alert message",
    message_type: "text",
    is_deleted: false,
    is_archived: false,
    archived_at: null,
    is_pinned: false,
    pin_id: null,
    pinned_at: null,
    edited_at: null,
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
    sender,
    reply_to: null,
    attachments: [],
    mentions: [],
    reactions: [],
    ...overrides
  };
}

describe("chat unread panel positioning", () => {
  const scrolledElements: Element[] = [];

  beforeEach(() => {
    apiMocks.getGroupMessages.mockResolvedValue([
      message({ id: "message-read", body: "Already read" }),
      message({ id: "message-unread", body: "Unread group alert" })
    ]);
    apiMocks.getPinnedMessages.mockResolvedValue([]);
    scrolledElements.length = 0;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(function (this: Element) {
        scrolledElements.push(this);
      })
    });
  });

  it("positions the first unread group message itself instead of its separator", async () => {
    render(
      <GroupChatPanel
        canModerateMessages={false}
        currentUser={currentUser}
        dictionary={en}
        groupId="group-1"
        locale="en"
        onMarkRead={vi.fn()}
        unread={{
          chat_type: "group",
          chat_id: "group-1",
          unread_count: 1,
          mention_count: 0,
          first_unread_message_id: "message-unread",
          newest_unread_message_id: "message-unread"
        }}
      />
    );

    await screen.findByText("Unread group alert");
    await waitFor(() => expect(scrolledElements.length).toBeGreaterThan(0));
    expect(scrolledElements.at(-1)).toHaveAttribute("data-message-id", "message-unread");
  });
});
