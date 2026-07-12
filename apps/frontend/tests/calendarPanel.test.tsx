import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CalendarPanel } from "../components/CalendarPanel";
import { NotificationCenter } from "../components/NotificationCenter";
import en from "../dictionaries/en.json";
import type { OfficeChatCalendarEvent } from "../lib/api";
import { userFactory } from "./factories";

vi.mock("../lib/session", () => ({
  getStoredAccessToken: () => "token"
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    getCalendarEvents: vi.fn(async () => ({
      items: [
        {
          id: "event-1",
          title: "Planning",
          description: "Weekly planning",
          event_type: "meeting",
          status: "scheduled",
          is_all_day: false,
          starts_at: "2026-07-15T07:00:00Z",
          ends_at: "2026-07-15T08:00:00Z",
          all_day_start_date: null,
          all_day_end_date: null,
          timezone: "Europe/Moscow",
          location: "Room 2",
          conference_url: "https://meet.example.test/room",
          created_by: { id: "user-1", username: "admin", display_name: "Admin" },
          audience_summary: { type: "selected_users", recipient_count: 1 },
          editable_audience: {
            audience_type: "selected_users",
            group_ids: [],
            user_ids: ["user-2"]
          },
          reminder_minutes: [15],
          can_manage: true,
          cancelled_at: null,
          cancellation_reason: null,
          created_at: "2026-07-14T10:00:00Z",
          updated_at: "2026-07-14T10:00:00Z"
        } satisfies OfficeChatCalendarEvent
      ],
      total: 1,
      limit: 500
    })),
    previewCalendarAudience: vi.fn(async () => ({
      recipient_count: 1,
      group_count: 0,
      excluded_disabled: 0,
      excluded_bots: 0,
      duplicates_removed: 0
    })),
    createCalendarEvent: vi.fn(),
    updateCalendarEvent: vi.fn(),
    cancelCalendarEvent: vi.fn()
  };
});

describe("calendar panel", () => {
  it("renders calendar views and opens event details with a safe join link", async () => {
    render(
      <CalendarPanel
        currentUser={userFactory({ role: "superadmin", permissions: ["can_manage_calendar"] })}
        dictionary={en}
        groups={[]}
        locale="en"
        users={[userFactory({ id: "user-2", username: "vladimir", display_name: "Vladimir" })]}
      />
    );

    expect(screen.getByRole("button", { name: "Create event" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Agenda" }));

    await waitFor(() => expect(screen.getByText("Planning")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Planning"));

    const join = screen.getByRole("link", { name: /Join/ });
    expect(join).toHaveAttribute("target", "_blank");
    expect(join).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows calendar notification filter", () => {
    render(
      <NotificationCenter
        dictionary={en}
        filter="calendar"
        hasMore={false}
        isLoading={false}
        isOpen
        items={[]}
        locale="en"
        onClose={vi.fn()}
        onDismiss={vi.fn()}
        onFilterChange={vi.fn()}
        onLoadMore={vi.fn()}
        onMarkAllRead={vi.fn()}
        onMarkRead={vi.fn()}
        onOpen={vi.fn()}
        unreadCount={0}
      />
    );
    expect(screen.getByRole("tab", { name: "Calendar" })).toHaveAttribute("aria-selected", "true");
  });

  it("uses searchable checkbox selectors for selected users", async () => {
    render(
      <CalendarPanel
        currentUser={userFactory({ role: "superadmin", permissions: ["can_manage_calendar"] })}
        dictionary={en}
        groups={[]}
        locale="en"
        users={[userFactory({ id: "user-2", username: "vladimir", display_name: "Vladimir" })]}
      />
    );

    await waitFor(() => expect(screen.getByText("Planning")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));

    expect(screen.getByPlaceholderText("Search audience")).toBeInTheDocument();
    expect(screen.getByLabelText(/Vladimir/)).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Users" })).not.toBeInTheDocument();
  });
});
