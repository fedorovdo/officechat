import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AnnouncementsPanel } from "../components/AnnouncementsPanel";
import { getDictionary } from "../lib/i18n";
import type { BroadcastPreview } from "../lib/api";
import { ApiResponseError } from "../lib/api";
import { userFactory } from "./factories";

const apiMocks = vi.hoisted(() => ({
  createBroadcast: vi.fn(),
  dismissAnnouncement: vi.fn(),
  getAnnouncement: vi.fn(),
  getAnnouncementUnread: vi.fn(),
  getAnnouncements: vi.fn(),
  getSentBroadcasts: vi.fn(),
  hasPermission: vi.fn((user, permission) => user.permissions.includes(permission)),
  previewBroadcastRecipients: vi.fn(),
  requireStoredAccessToken: vi.fn(() => "test-token"),
  retractBroadcast: vi.fn(),
  sendBroadcast: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, ...apiMocks };
});

const en = getDictionary("en");
const user = userFactory({ id: "user-1", permissions: [] });
const sender = userFactory({ id: "user-2", display_name: "Sender", permissions: ["can_broadcast"] });
const groups = [
  {
    id: "group-1",
    name: "IT",
    slug: "it",
    description: null,
    is_private: true,
    is_system: false,
    is_active: true,
    created_by_user_id: null,
    created_at: "2026-07-11T10:00:00Z",
    updated_at: "2026-07-11T10:00:00Z"
  }
];

const preview: BroadcastPreview = {
  recipient_count: 2,
  group_count: 1,
  excluded_disabled: 0,
  excluded_bots: 0,
  duplicates_removed: 0,
  audience_hash: "hash",
  confirmation_token: "token",
  expires_at: "2026-07-11T10:05:00Z"
};

describe("broadcast announcements panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getAnnouncements.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
    apiMocks.getAnnouncementUnread.mockResolvedValue({ unread_count: 0 });
    apiMocks.getSentBroadcasts.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
    apiMocks.previewBroadcastRecipients.mockResolvedValue(preview);
    apiMocks.createBroadcast.mockResolvedValue({ id: "broadcast-1" });
    apiMocks.sendBroadcast.mockResolvedValue({ id: "broadcast-1" });
  });

  it("shows inbox without sender controls for users without can_broadcast", async () => {
    render(
      <AnnouncementsPanel
        currentUser={user}
        dictionary={en}
        groups={groups}
        locale="en"
        onUnreadChange={vi.fn()}
        reloadKey={0}
        users={[user, sender]}
      />
    );

    expect(await screen.findByRole("heading", { name: en.announcements.inbox })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: en.announcements.compose })).not.toBeInTheDocument();
  });

  it("previews recipients before sending a broadcast", async () => {
    render(
      <AnnouncementsPanel
        currentUser={sender}
        dictionary={en}
        groups={groups}
        locale="en"
        onUnreadChange={vi.fn()}
        reloadKey={0}
        users={[user, sender]}
      />
    );

    fireEvent.change(await screen.findByLabelText(en.announcements.fields.title), { target: { value: "Maintenance" } });
    fireEvent.change(screen.getByLabelText(en.announcements.fields.body), { target: { value: "Tonight at 22:00" } });
    fireEvent.click(screen.getByLabelText("IT"));
    fireEvent.click(screen.getByRole("button", { name: en.announcements.preview }));

    await waitFor(() =>
      expect(apiMocks.previewBroadcastRecipients).toHaveBeenCalledWith("test-token", {
        audience_type: "selected_groups",
        group_ids: ["group-1"],
        user_ids: []
      })
    );
    expect(screen.getByText(en.announcements.recipients.replace("{count}", "2"))).toBeInTheDocument();
  });

  it("does not render raw backend internals after draft save failure", async () => {
    apiMocks.createBroadcast.mockRejectedValueOnce(
      new Error("MissingGreenlet: 1 validation error for BroadcastPublic updated_at")
    );
    render(
      <AnnouncementsPanel
        currentUser={sender}
        dictionary={en}
        groups={groups}
        locale="en"
        onUnreadChange={vi.fn()}
        reloadKey={0}
        users={[user, sender]}
      />
    );

    fireEvent.change(await screen.findByLabelText(en.announcements.fields.title), { target: { value: "Maintenance" } });
    fireEvent.change(screen.getByLabelText(en.announcements.fields.body), { target: { value: "Tonight" } });
    fireEvent.click(screen.getByLabelText("IT"));
    fireEvent.click(screen.getByRole("button", { name: en.announcements.preview }));
    await screen.findByText(en.announcements.recipients.replace("{count}", "2"));
    fireEvent.click(screen.getByRole("button", { name: en.announcements.send }));

    expect(await screen.findByText(en.announcements.draftSaveError)).toBeInTheDocument();
    expect(screen.queryByText(/MissingGreenlet|BroadcastPublic|updated_at/)).not.toBeInTheDocument();
  });

  it("preserves idempotency key and refreshes history after ambiguous send failure", async () => {
    apiMocks.sendBroadcast.mockRejectedValueOnce(new ApiResponseError(500, "MissingGreenlet greenlet_spawn"));
    render(
      <AnnouncementsPanel
        currentUser={sender}
        dictionary={en}
        groups={groups}
        locale="en"
        onUnreadChange={vi.fn()}
        reloadKey={0}
        users={[user, sender]}
      />
    );

    fireEvent.change(await screen.findByLabelText(en.announcements.fields.title), { target: { value: "Maintenance" } });
    fireEvent.change(screen.getByLabelText(en.announcements.fields.body), { target: { value: "Tonight" } });
    fireEvent.click(screen.getByLabelText("IT"));
    fireEvent.click(screen.getByRole("button", { name: en.announcements.preview }));
    await screen.findByText(en.announcements.recipients.replace("{count}", "2"));
    fireEvent.click(screen.getByRole("button", { name: en.announcements.send }));

    expect(await screen.findByText(en.announcements.mayAlreadySent)).toBeInTheDocument();
    expect(screen.queryByText(/MissingGreenlet|greenlet_spawn/)).not.toBeInTheDocument();
    expect(apiMocks.getSentBroadcasts).toHaveBeenCalledTimes(2);
    const firstKey = apiMocks.sendBroadcast.mock.calls[0][2].idempotency_key;
    apiMocks.sendBroadcast.mockResolvedValueOnce({ id: "broadcast-1" });
    fireEvent.click(screen.getByRole("button", { name: en.announcements.send }));
    await waitFor(() => expect(apiMocks.sendBroadcast).toHaveBeenCalledTimes(2));
    expect(apiMocks.sendBroadcast.mock.calls[1][2].idempotency_key).toBe(firstKey);
    expect(apiMocks.createBroadcast).toHaveBeenCalledTimes(1);
  });
});
