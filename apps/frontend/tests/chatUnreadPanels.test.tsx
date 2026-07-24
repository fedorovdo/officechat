import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GroupChatPanel } from "../components/GroupChatPanel";
import en from "../dictionaries/en.json";
import type { OfficeChatMessage } from "../lib/api";
import { userFactory } from "./factories";
import { TestWebSocket } from "./setup";

const apiMocks = vi.hoisted(() => ({
  getGroupMessages: vi.fn(),
  getPinnedMessages: vi.fn(),
  getStoredAccessToken: vi.fn(() => "test-token")
}));
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock
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
  const scrollCalls: Array<{ element: HTMLElement; options: ScrollToOptions }> = [];

  beforeEach(() => {
    apiMocks.getGroupMessages.mockResolvedValue([
      message({ id: "message-read", body: "Already read" }),
      message({ id: "message-unread", body: "Unread group alert" })
    ]);
    apiMocks.getPinnedMessages.mockResolvedValue([]);
    scrollCalls.length = 0;
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
        scrollCalls.push({ element: this, options });
      })
    });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: vi.fn(function (this: HTMLElement) {
        if (this.dataset.messageId === "message-unread") {
          return { top: 1000, height: 900 };
        }
        if (this.classList.contains("messages-list")) {
          return { top: 100, height: 600 };
        }
        return { top: 0, height: 0 };
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
    await waitFor(() => expect(scrollCalls.length).toBeGreaterThan(0));
    expect(scrollCalls.at(-1)?.element).toHaveClass("messages-list");
    expect(scrollCalls.at(-1)?.options).toEqual({ top: 700, behavior: "auto" });
  });

  it("shows a bounded-history notice when the first unread message cannot be loaded", async () => {
    apiMocks.getGroupMessages.mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => message({
        id: `latest-${index}`,
        body: `Latest ${index}`
      }))
    );

    render(
      <GroupChatPanel
        canModerateMessages={false}
        currentUser={currentUser}
        dictionary={en}
        groupId="group-1"
        locale="en"
        unread={{
          chat_type: "group",
          chat_id: "group-1",
          unread_count: 1,
          mention_count: 0,
          first_unread_message_id: "message-too-old",
          newest_unread_message_id: "message-too-old"
        }}
      />
    );

    expect(await screen.findByText(en.unread.earlierMessagesOutsideWindow)).toBeVisible();
  });

  it("does not merge an old group's delayed live refresh into the selected group", async () => {
    let resolveOldRefresh!: (messages: OfficeChatMessage[]) => void;
    let groupACalls = 0;
    apiMocks.getGroupMessages.mockImplementation(
      (_token: string, groupId: string) => {
        if (groupId === "group-b") {
          return Promise.resolve([message({ id: "group-b-message", group_id: "group-b", body: "Group B" })]);
        }
        groupACalls += 1;
        if (groupACalls === 1) {
          return Promise.resolve([message({ id: "group-a-message", body: "Group A" })]);
        }
        return new Promise<OfficeChatMessage[]>((resolve) => {
          resolveOldRefresh = resolve;
        });
      }
    );

    const { rerender } = render(
      <GroupChatPanel
        canModerateMessages={false}
        currentUser={currentUser}
        dictionary={en}
        groupId="group-a"
        locale="en"
      />
    );
    await screen.findByText("Group A");
    await waitFor(() => expect(TestWebSocket.instances.length).toBeGreaterThan(0));
    act(() => {
      TestWebSocket.instances[0].receive({ type: "message.created" });
    });
    await waitFor(() => expect(groupACalls).toBe(2));

    rerender(
      <GroupChatPanel
        canModerateMessages={false}
        currentUser={currentUser}
        dictionary={en}
        groupId="group-b"
        locale="en"
      />
    );
    await screen.findByText("Group B");
    await act(async () => {
      resolveOldRefresh([message({ id: "stale-group-a", body: "Stale group A" })]);
      await Promise.resolve();
    });

    expect(screen.queryByText("Stale group A")).not.toBeInTheDocument();
    expect(screen.getByText("Group B")).toBeVisible();
  });
});
