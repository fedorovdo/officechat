import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageAttachments } from "../components/MessageAttachments";
import { ChatArchivePanel } from "../components/ChatArchivePanel";
import en from "../dictionaries/en.json";
import type { OfficeChatAttachment } from "../lib/api";
import { applyDeletedMessageEvent, sanitizeDeletedMessage } from "../lib/message-privacy";

const staleAttachment: OfficeChatAttachment = {
  id: "attachment-1",
  original_filename: "private.txt",
  content_type: "text/plain",
  size_bytes: 7,
  created_at: "2026-07-20T10:00:00Z",
  download_url: "/api/private/download",
  file_available: true,
  file_deleted_at: null
};

describe("deleted message privacy", () => {
  it("does not render stale attachment metadata or download actions", () => {
    const onDownload = vi.fn();
    render(
      <MessageAttachments
        attachments={[staleAttachment]}
        dictionary={en}
        isDeleted
        onDownload={onDownload}
      />
    );

    expect(screen.queryByText("private.txt")).not.toBeInTheDocument();
    expect(screen.queryByText(en.messages.download)).not.toBeInTheDocument();
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("does not expose stale attachments through archive history", () => {
    render(
      <ChatArchivePanel
        dictionary={en}
        hasMore={false}
        loading={false}
        locale="en"
        messages={[{
          id: "message-1",
          body: "secret",
          is_deleted: true,
          is_archived: true,
          archived_at: "2026-07-20T10:00:00Z",
          created_at: "2026-07-19T10:00:00Z",
          sender: {
            id: "user-1",
            username: "user",
            display_name: "User",
            role: "user",
            is_active: true,
            avatar_url: null,
            last_seen_at: null
          },
          attachments: [staleAttachment],
          reactions: [{ emoji: "ok", count: 1, reacted_by_me: false, users: [] }]
        }]}
        onClose={vi.fn()}
        onDownload={vi.fn()}
        onLoadMore={vi.fn()}
      />
    );

    expect(screen.getByText(en.messages.deletedMessage)).toBeInTheDocument();
    expect(screen.queryByText("private.txt")).not.toBeInTheDocument();
    expect(screen.queryByText("ok 1")).not.toBeInTheDocument();
  });

  it("sanitizes stale group, direct, and discussion delete payloads", () => {
    for (const message of [
      {
        id: "group-message",
        body: "secret",
        is_deleted: true,
        attachments: [staleAttachment],
        mentions: [{ username: "private" }],
        reactions: [{ emoji: "ok" }],
        reply_to: { body_preview: "private reply" },
        reply_to_message_id: "reply-1"
      },
      {
        id: "direct-message",
        body: "secret",
        is_deleted: true,
        attachments: [staleAttachment],
        reactions: [{ emoji: "ok" }],
        reply_to: { body_preview: "private reply" },
        reply_to_message_id: "reply-1"
      },
      {
        id: "discussion-message",
        body: "secret",
        is_deleted: true,
        attachments: [staleAttachment],
        reactions: [{ emoji: "ok" }]
      }
    ]) {
      const tombstone = sanitizeDeletedMessage(message);
      expect(tombstone.body).toBe("");
      expect(tombstone.attachments).toEqual([]);
      expect(tombstone.reactions).toEqual([]);
      if ("reply_to" in tombstone) {
        expect(tombstone.reply_to).toBeNull();
        expect(tombstone.reply_to_message_id).toBeNull();
      }
    }
  });

  it("replaces local WebSocket message state with the sanitized tombstone", () => {
    const current = {
      id: "message-1",
      body: "old body",
      is_deleted: false,
      attachments: [staleAttachment],
      reactions: [{ emoji: "ok" }]
    };
    const staleDeletePayload = { ...current, body: "old body", is_deleted: true };

    const result = applyDeletedMessageEvent([current], staleDeletePayload);

    expect(result[0].is_deleted).toBe(true);
    expect(result[0].body).toBe("");
    expect(result[0].attachments).toEqual([]);
    expect(result[0].reactions).toEqual([]);
  });
});
