import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DirectChatPanel } from "../components/DirectChatPanel";
import { DiscussionPanel } from "../components/DiscussionPanel";
import { GroupChatPanel } from "../components/GroupChatPanel";
import { getDictionary } from "../lib/i18n";
import type {
  OfficeChatDirectConversation,
  OfficeChatDirectMessage,
  OfficeChatDiscussion,
  OfficeChatDiscussionMessage,
  OfficeChatMessage,
  OfficeChatPinnedMessage,
  OfficeChatUser
} from "../lib/api";
import { conversationFactory, userFactory } from "./factories";
import { TestWebSocket } from "./setup";

const apiMocks = vi.hoisted(() => ({
  getArchivedDirectMessages: vi.fn(),
  getArchivedDiscussionMessages: vi.fn(),
  getArchivedGroupMessages: vi.fn(),
  getDirectMessages: vi.fn(),
  getDirectReadReceipt: vi.fn(),
  getDiscussion: vi.fn(),
  getDiscussionMessages: vi.fn(),
  getGroupMessages: vi.fn(),
  getPinnedMessages: vi.fn(),
  getStoredAccessToken: vi.fn(() => "test-token"),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
  updatePinnedMessage: vi.fn()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() })
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, ...apiMocks };
});

const en = getDictionary("en");
const ru = getDictionary("ru");
const currentUser = userFactory({
  id: "user-1",
  username: "dmitrii",
  display_name: "Dmitrii",
  permissions: ["can_pin_messages"]
});
const noPinUser = userFactory({ id: "user-1", username: "dmitrii", display_name: "Dmitrii", permissions: [] });
const sender = userFactory({ id: "user-2", username: "vladimir", display_name: "Vladimir" });
const conversation = conversationFactory({
  id: "direct-1",
  user_one_id: currentUser.id,
  user_two_id: sender.id,
  other_user: sender
}) as OfficeChatDirectConversation;

function groupMessage(overrides: Partial<OfficeChatMessage> = {}): OfficeChatMessage {
  return {
    id: "message-1",
    group_id: "group-1",
    sender_user_id: sender.id,
    reply_to_message_id: null,
    body: "Pin me",
    message_type: "text",
    is_deleted: false,
    is_archived: false,
    archived_at: null,
    is_pinned: false,
    pin_id: null,
    pinned_at: null,
    edited_at: null,
    created_at: "2026-07-04T10:00:00Z",
    updated_at: "2026-07-04T10:00:00Z",
    sender,
    reply_to: null,
    attachments: [],
    mentions: [],
    reactions: [],
    ...overrides
  };
}

function directMessage(overrides: Partial<OfficeChatDirectMessage> = {}): OfficeChatDirectMessage {
  return {
    id: "message-1",
    conversation_id: "direct-1",
    sender_user_id: sender.id,
    reply_to_message_id: null,
    body: "Pin me",
    message_type: "text",
    is_deleted: false,
    is_archived: false,
    archived_at: null,
    is_pinned: false,
    pin_id: null,
    pinned_at: null,
    edited_at: null,
    created_at: "2026-07-04T10:00:00Z",
    updated_at: "2026-07-04T10:00:00Z",
    sender,
    reply_to: null,
    attachments: [],
    reactions: [],
    ...overrides
  };
}

function discussionMessage(overrides: Partial<OfficeChatDiscussionMessage> = {}): OfficeChatDiscussionMessage {
  return {
    id: "message-1",
    discussion_id: "discussion-1",
    sender_user_id: sender.id,
    body: "Pin me",
    is_deleted: false,
    is_archived: false,
    archived_at: null,
    is_pinned: false,
    pin_id: null,
    pinned_at: null,
    edited_at: null,
    created_at: "2026-07-04T10:00:00Z",
    updated_at: "2026-07-04T10:00:00Z",
    sender,
    attachments: [],
    reactions: [],
    ...overrides
  };
}

const staleDeletedAttachment = {
  id: "attachment-1",
  original_filename: "private.txt",
  content_type: "text/plain",
  size_bytes: 7,
  created_at: "2026-07-20T10:00:00Z",
  download_url: "/api/private/download",
  file_available: true,
  file_deleted_at: null
};

function pinFactory(overrides: Partial<OfficeChatPinnedMessage> = {}): OfficeChatPinnedMessage {
  return {
    id: "pin-1",
    chat_type: "direct",
    chat_id: "direct-1",
    message_id: "message-1",
    note: null,
    pinned_by: { id: currentUser.id, username: currentUser.username, display_name: currentUser.display_name },
    pinned_at: "2026-07-04T10:01:00Z",
    created_at: "2026-07-04T10:01:00Z",
    updated_at: "2026-07-04T10:01:00Z",
    message: {
      id: "message-1",
      sender: { id: sender.id, username: sender.username, display_name: sender.display_name },
      body_preview: "Pin me",
      attachment_count: 0,
      is_deleted: false,
      is_archived: false,
      archived_at: null,
      created_at: "2026-07-04T10:00:00Z"
    },
    ...overrides
  };
}

function discussionFactory(): OfficeChatDiscussion {
  return {
    id: "discussion-1",
    source_group_id: "group-1",
    source_message_id: "source-1",
    title: "Discussion",
    created_by_user_id: currentUser.id,
    is_active: true,
    created_at: "2026-07-04T10:00:00Z",
    updated_at: "2026-07-04T10:00:00Z",
    source_message: {
      id: "source-1",
      sender,
      body_preview: "Source",
      is_deleted: false,
      created_at: "2026-07-04T09:00:00Z"
    },
    members: [
      { id: "member-1", discussion_id: "discussion-1", user_id: currentUser.id, role: "owner", joined_at: "2026-07-04T10:00:00Z", user: currentUser },
      { id: "member-2", discussion_id: "discussion-1", user_id: sender.id, role: "member", joined_at: "2026-07-04T10:00:00Z", user: sender }
    ],
    can_manage_members: true
  };
}

function setupApi({
  directMessages = [directMessage()],
  discussionMessages = [discussionMessage()],
  groupMessages = [groupMessage()],
  pins = []
}: {
  directMessages?: OfficeChatDirectMessage[];
  discussionMessages?: OfficeChatDiscussionMessage[];
  groupMessages?: OfficeChatMessage[];
  pins?: OfficeChatPinnedMessage[];
} = {}) {
  apiMocks.getDirectMessages.mockResolvedValue(directMessages);
  apiMocks.getDirectReadReceipt.mockResolvedValue({
    conversation_id: "direct-1",
    reader_user_id: sender.id,
    last_read_message_id: null,
    last_read_message_created_at: null,
    read_at: null
  });
  apiMocks.getDiscussion.mockResolvedValue(discussionFactory());
  apiMocks.getDiscussionMessages.mockResolvedValue(discussionMessages);
  apiMocks.getGroupMessages.mockResolvedValue(groupMessages);
  apiMocks.getPinnedMessages.mockResolvedValue(pins);
  apiMocks.pinMessage.mockResolvedValue(pinFactory());
  apiMocks.unpinMessage.mockResolvedValue(undefined);
  apiMocks.updatePinnedMessage.mockResolvedValue(pinFactory());
}

async function openActions(label = en.messages.moreActions) {
  fireEvent.click(await screen.findByRole("button", { name: label }));
}

describe("pinned message frontend integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollTo = vi.fn();
    setupApi();
  });

  it("shows group Pin through a visible message actions menu", async () => {
    render(<GroupChatPanel canModerateMessages currentUser={currentUser} dictionary={en} groupId="group-1" locale="en" />);
    await openActions();
    expect(screen.getByRole("menuitem", { name: en.pins.pin })).toBeInTheDocument();
  });

  it("shows direct Pin through the same visible action menu", async () => {
    render(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={en} locale="en" />);
    await openActions();
    expect(screen.getByRole("menuitem", { name: en.pins.pin })).toBeInTheDocument();
  });

  it("shows discussion Pin through the same visible action menu", async () => {
    render(<DiscussionPanel currentUser={currentUser} dictionary={en} discussionId="discussion-1" locale="en" onClose={vi.fn()} />);
    await openActions();
    expect(screen.getByRole("menuitem", { name: en.pins.pin })).toBeInTheDocument();
  });

  it("group tombstone hides stale attachment payloads", async () => {
    setupApi({
      groupMessages: [groupMessage({
        is_deleted: true,
        attachments: [{ ...staleDeletedAttachment, group_id: "group-1" }]
      })]
    });
    render(<GroupChatPanel canModerateMessages currentUser={currentUser} dictionary={en} groupId="group-1" locale="en" />);
    expect(await screen.findByText(en.messages.deletedMessage)).toBeInTheDocument();
    expect(screen.queryByText("private.txt")).not.toBeInTheDocument();
  });

  it("direct tombstone hides stale attachment payloads", async () => {
    setupApi({ directMessages: [directMessage({ is_deleted: true, attachments: [staleDeletedAttachment] })] });
    render(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={en} locale="en" />);
    expect(await screen.findByText(en.messages.deletedMessage)).toBeInTheDocument();
    expect(screen.queryByText("private.txt")).not.toBeInTheDocument();
  });

  it("discussion tombstone hides stale attachment payloads", async () => {
    setupApi({
      discussionMessages: [discussionMessage({ is_deleted: true, attachments: [staleDeletedAttachment] })]
    });
    render(<DiscussionPanel currentUser={currentUser} dictionary={en} discussionId="discussion-1" locale="en" onClose={vi.fn()} />);
    expect(await screen.findByText(en.messages.deletedMessage)).toBeInTheDocument();
    expect(screen.queryByText("private.txt")).not.toBeInTheDocument();
  });

  it("does not show Pin without effective can_pin_messages permission", async () => {
    render(<DirectChatPanel conversation={conversation} currentUser={noPinUser} dictionary={en} locale="en" />);
    await openActions();
    expect(screen.queryByRole("menuitem", { name: en.pins.pin })).not.toBeInTheDocument();
  });

  it("does not infer Pin from admin or moderator-like roles without permission", async () => {
    const adminWithoutPermission = userFactory({ role: "admin", permissions: [] });
    render(<DirectChatPanel conversation={conversation} currentUser={adminWithoutPermission} dictionary={en} locale="en" />);
    await openActions();
    expect(screen.queryByRole("menuitem", { name: en.pins.pin })).not.toBeInTheDocument();
  });

  it("allows superadmin when can_pin_messages is present in effective permissions", async () => {
    const superadmin = userFactory({ role: "superadmin", permissions: ["can_pin_messages"] });
    render(<DirectChatPanel conversation={conversation} currentUser={superadmin} dictionary={en} locale="en" />);
    await openActions();
    expect(screen.getByRole("menuitem", { name: en.pins.pin })).toBeInTheDocument();
  });

  it("keeps reaction Add separate from message actions", async () => {
    render(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={en} locale="en" />);
    expect(await screen.findByRole("button", { name: en.messages.reactions.add })).toBeInTheDocument();
    await openActions();
    expect(screen.getByRole("menuitem", { name: en.pins.pin })).toBeInTheDocument();
  });

  it("group composer renders the shared attachment button with an accessible name", async () => {
    render(<GroupChatPanel canModerateMessages currentUser={currentUser} dictionary={en} groupId="group-1" locale="en" />);
    const attachmentButton = await screen.findByRole("button", { name: en.messages.attachFiles });
    expect(attachmentButton).toHaveTextContent("📎");
    expect(attachmentButton).not.toHaveTextContent("+");
    expect(attachmentButton).toHaveAttribute("title", en.messages.attachFiles);
  });

  it("direct composer renders the same attachment control", async () => {
    render(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={en} locale="en" />);
    const attachmentButton = await screen.findByRole("button", { name: en.messages.attachFiles });
    expect(attachmentButton).toHaveTextContent("📎");
    expect(attachmentButton).not.toHaveTextContent("+");
  });

  it("discussion composer renders the same attachment control", async () => {
    render(<DiscussionPanel currentUser={currentUser} dictionary={ru} discussionId="discussion-1" locale="ru" onClose={vi.fn()} />);
    const attachmentButton = await screen.findByRole("button", { name: ru.messages.attachFiles });
    expect(attachmentButton).toHaveTextContent("📎");
    expect(attachmentButton).not.toHaveTextContent("+");
  });

  it("opens a pin confirmation panel and sends the correct payload", async () => {
    render(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={en} locale="en" />);
    await openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: en.pins.pin }));
    fireEvent.change(screen.getByPlaceholderText(en.pins.notePlaceholder), { target: { value: "Important" } });
    fireEvent.click(screen.getByRole("button", { name: en.pins.pin }));
    await waitFor(() =>
      expect(apiMocks.pinMessage).toHaveBeenCalledWith("test-token", "direct", "direct-1", "message-1", "Important")
    );
  });

  it("updates the message state after a successful pin without reloading messages", async () => {
    render(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={en} locale="en" />);
    await openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: en.pins.pin }));
    fireEvent.click(screen.getByRole("button", { name: en.pins.pin }));
    await waitFor(() => expect(apiMocks.pinMessage).toHaveBeenCalledOnce());
    expect(screen.getByText(en.pins.pinSuccess)).toBeInTheDocument();
  });

  it("unpinned messages use the actual pin id", async () => {
    const pin = pinFactory();
    setupApi({ directMessages: [directMessage({ is_pinned: true, pin_id: pin.id, pinned_at: pin.pinned_at })], pins: [pin] });
    render(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={en} locale="en" />);
    await openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: en.pins.unpin }));
    await waitFor(() => expect(apiMocks.unpinMessage).toHaveBeenCalledWith("test-token", pin.id));
  });

  it("updates pin state from WebSocket pin and unpin events", async () => {
    render(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={en} locale="en" />);
    const pin = pinFactory();
    await screen.findByText("Pin me");
    await waitFor(() => expect(TestWebSocket.instances.length).toBeGreaterThan(0));
    await act(async () => {
      TestWebSocket.instances.at(-1)?.receive({ type: "message.pinned", chat_type: "direct", chat_id: "direct-1", pin_id: pin.id, message_id: "message-1", pin });
      await Promise.resolve();
    });
    await act(async () => {
      TestWebSocket.instances.at(-1)?.receive({ type: "message.unpinned", chat_type: "direct", chat_id: "direct-1", pin_id: pin.id, message_id: "message-1" });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: en.messages.moreActions })).toBeInTheDocument();
  });

  it("shows and hides Pin as effective permissions change in session state", async () => {
    const { rerender } = render(<DirectChatPanel conversation={conversation} currentUser={noPinUser} dictionary={en} locale="en" />);
    await openActions();
    expect(screen.queryByRole("menuitem", { name: en.pins.pin })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.messages.moreActions }));
    rerender(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={en} locale="en" />);
    await openActions();
    expect(screen.getByRole("menuitem", { name: en.pins.pin })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.messages.moreActions }));
    rerender(<DirectChatPanel conversation={conversation} currentUser={noPinUser} dictionary={en} locale="en" />);
    await openActions();
    expect(screen.queryByRole("menuitem", { name: en.pins.pin })).not.toBeInTheDocument();
  });

  it("keeps the pinned strip viewable after pin permission is revoked", async () => {
    const pin = pinFactory();
    setupApi({ directMessages: [directMessage({ is_pinned: true, pin_id: pin.id, pinned_at: pin.pinned_at })], pins: [pin] });
    render(<DirectChatPanel conversation={conversation} currentUser={noPinUser} dictionary={en} locale="en" />);
    fireEvent.click(await screen.findByRole("button", { name: en.pins.openList }));
    expect(screen.getAllByText(pin.message.body_preview).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: en.pins.unpin })).not.toBeInTheDocument();
  });

  it("does not offer Pin for archived messages", async () => {
    setupApi({ directMessages: [directMessage({ is_archived: true, archived_at: "2026-07-04T11:00:00Z" })] });
    render(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={en} locale="en" />);
    await openActions();
    expect(screen.queryByRole("menuitem", { name: en.pins.pin })).not.toBeInTheDocument();
  });

  it("does not offer actions for deleted messages", async () => {
    setupApi({ directMessages: [directMessage({ is_deleted: true })] });
    render(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={en} locale="en" />);
    await screen.findByText(en.messages.deletedMessage);
    expect(screen.queryByRole("button", { name: en.messages.moreActions })).not.toBeInTheDocument();
  });

  it("keeps the mobile-friendly actions trigger visible", async () => {
    render(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={en} locale="en" />);
    expect(await screen.findByRole("button", { name: en.messages.moreActions })).toBeVisible();
  });

  it("uses EN and RU labels for the action menu", async () => {
    const { rerender } = render(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={en} locale="en" />);
    await openActions(en.messages.moreActions);
    expect(screen.getByRole("menuitem", { name: en.pins.pin })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.messages.moreActions }));
    rerender(<DirectChatPanel conversation={conversation} currentUser={currentUser} dictionary={ru} locale="ru" />);
    await openActions(ru.messages.moreActions);
    expect(screen.getByRole("menuitem", { name: ru.pins.pin })).toBeInTheDocument();
  });
});
