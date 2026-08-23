import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CalendarPanel } from "../components/CalendarPanel";
import { NotificationCenter } from "../components/NotificationCenter";
import en from "../dictionaries/en.json";
import ru from "../dictionaries/ru.json";
import type { OfficeChatCalendarEvent } from "../lib/api";
import { userFactory } from "./factories";

const apiMocks = vi.hoisted(() => ({
  getCalendarEvents: vi.fn(),
  previewCalendarAudience: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  cancelCalendarEvent: vi.fn(),
  restoreCalendarEvent: vi.fn()
}));

vi.mock("../lib/session", () => ({
  getStoredAccessToken: () => "token"
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    getCalendarEvents: apiMocks.getCalendarEvents,
    previewCalendarAudience: apiMocks.previewCalendarAudience,
    createCalendarEvent: apiMocks.createCalendarEvent,
    updateCalendarEvent: apiMocks.updateCalendarEvent,
    cancelCalendarEvent: apiMocks.cancelCalendarEvent,
    restoreCalendarEvent: apiMocks.restoreCalendarEvent
  };
});

function calendarEvent(patch: Partial<OfficeChatCalendarEvent>): OfficeChatCalendarEvent {
  return {
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
    updated_at: "2026-07-14T10:00:00Z",
    ...patch
  };
}

function defaultEvents() {
  return [
    calendarEvent({ id: "event-1", title: "Planning" }),
    calendarEvent({ id: "event-2", title: "Design review", event_type: "video_conference", starts_at: "2026-07-15T09:00:00Z", ends_at: "2026-07-15T10:00:00Z" }),
    calendarEvent({ id: "event-3", title: "Training", event_type: "training", starts_at: "2026-07-15T10:00:00Z", ends_at: "2026-07-15T11:00:00Z", conference_url: null }),
    calendarEvent({ id: "event-4", title: "Maintenance", event_type: "maintenance", starts_at: "2026-07-15T11:00:00Z", ends_at: "2026-07-15T12:00:00Z", conference_url: null }),
    calendarEvent({ id: "event-5", title: "Office party", event_type: "office_event", is_all_day: true, starts_at: null, ends_at: null, all_day_start_date: "2026-07-15", all_day_end_date: "2026-07-15", conference_url: null }),
    calendarEvent({ id: "event-27", title: "Board review July 27", starts_at: "2026-07-27T07:00:00Z", ends_at: "2026-07-27T08:00:00Z", conference_url: null }),
    calendarEvent({
      id: "event-cancelled",
      title: "Cancelled sync",
      status: "cancelled",
      starts_at: "2026-07-16T07:00:00Z",
      ends_at: "2026-07-16T08:00:00Z",
      cancellation_reason: "No longer needed",
      cancelled_at: "2026-07-14T11:00:00Z"
    })
  ];
}

function renderCalendar(role: "superadmin" | "user" = "superadmin", dictionary = en) {
  return render(
    <CalendarPanel
      currentUser={userFactory({ id: "user-1", role, permissions: role === "superadmin" ? ["can_manage_calendar"] : [] })}
      dictionary={dictionary}
      groups={[]}
      locale={dictionary === ru ? "ru" : "en"}
      users={[userFactory({ id: "user-2", username: "vladimir", display_name: "Vladimir" })]}
    />
  );
}

describe("calendar panel", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-14T09:00:00Z"));
    localStorage.clear();
    window.innerWidth = 1024;
    apiMocks.getCalendarEvents.mockResolvedValue({
      items: defaultEvents(),
      total: defaultEvents().length,
      limit: 500
    });
    apiMocks.previewCalendarAudience.mockResolvedValue({
      recipient_count: 1,
      group_count: 0,
      excluded_disabled: 0,
      excluded_bots: 0,
      duplicates_removed: 0
    });
    apiMocks.restoreCalendarEvent.mockResolvedValue(calendarEvent({ id: "event-cancelled", title: "Cancelled sync", status: "scheduled" }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders calendar views and opens event details with a safe join link", async () => {
    renderCalendar();

    expect(screen.getByRole("button", { name: "Create event" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Agenda" }));

    await waitFor(() => expect(screen.getAllByText("Planning")[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByText("Planning")[0]);

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
    renderCalendar();

    await waitFor(() => expect(screen.getAllByText("Planning")[0]).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));

    expect(screen.getByPlaceholderText("Search audience")).toBeInTheDocument();
    expect(screen.getByLabelText(/Vladimir/)).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Users" })).not.toBeInTheDocument();
  });

  it("supports today and previous/next calendar navigation", async () => {
    renderCalendar();
    await waitFor(() => expect(screen.getByLabelText("Calendar date")).toHaveValue("2026-07-14"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    });
    expect(screen.getByLabelText("Calendar date")).toHaveValue("2026-08-14");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    });
    expect(screen.getByLabelText("Calendar date")).toHaveValue("2026-07-14");

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Calendar date"), { target: { value: "2026-07-20" } });
      fireEvent.click(screen.getByRole("button", { name: "Today" }));
    });
    expect(screen.getByLabelText("Calendar date")).toHaveValue("2026-07-14");
  });

  it("opens on today's date in month view", async () => {
    renderCalendar();

    await waitFor(() => expect(screen.getByLabelText("Calendar date")).toHaveValue("2026-07-14"));
    expect(screen.getByRole("button", { name: "Month" })).toHaveClass("secondary-link-active");
    expect(screen.getByRole("button", { name: "14" })).toHaveAttribute("aria-current", "date");
  });

  it("highlights today and selected dates", async () => {
    const { container } = renderCalendar();
    await waitFor(() => expect(screen.getByLabelText("Calendar date")).toHaveValue("2026-07-14"));

    expect(container.querySelector(".calendar-date-today")).toBeTruthy();
    expect(container.querySelector(".calendar-date-selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "14" })).toHaveAttribute("aria-current", "date");
  });

  it("opens the selected date's month and highlights its cell", async () => {
    const { container } = renderCalendar();
    await waitFor(() => expect(screen.getByLabelText("Calendar date")).toHaveValue("2026-07-14"));

    fireEvent.change(screen.getByLabelText("Calendar date"), { target: { value: "2026-08-27" } });

    await waitFor(() => {
      expect(apiMocks.getCalendarEvents).toHaveBeenCalledWith("token", expect.objectContaining({
        date_from: "2026-07-27",
        date_to: "2026-09-06"
      }));
    });
    expect(screen.getByLabelText("Calendar date")).toHaveValue("2026-08-27");
    expect(container.querySelector(".calendar-date-selected .calendar-date-button")).toHaveTextContent("27");
    expect(container.querySelector(".calendar-month-grid-6")).toBeTruthy();
  });

  it("does not reload the same month when selecting another date inside it", async () => {
    const { container } = renderCalendar();
    await waitFor(() => expect(apiMocks.getCalendarEvents).toHaveBeenCalledTimes(2));
    apiMocks.getCalendarEvents.mockClear();

    fireEvent.change(screen.getByLabelText("Calendar date"), { target: { value: "2026-07-20" } });

    expect(container.querySelector(".calendar-date-selected .calendar-date-button")).toHaveTextContent("20");
    expect(apiMocks.getCalendarEvents).not.toHaveBeenCalled();
  });

  it("shows an event on July 27 in its month cell", async () => {
    renderCalendar();

    await waitFor(() => expect(screen.getByText("Board review July 27")).toBeInTheDocument());
    expect(screen.getByText("Board review July 27").closest(".calendar-month-cell")?.querySelector(".calendar-date-button")).toHaveTextContent("27");
  });

  it("opens prefilled create form from an empty day for managers only", async () => {
    renderCalendar();
    await waitFor(() => expect(screen.getByRole("button", { name: "18" })).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "18" }));
    });
    expect(screen.getByLabelText("Starts")).toHaveValue("2026-07-18T09:00");
  });

  it("does not open create form from an empty day for regular users", async () => {
    renderCalendar("user");
    await waitFor(() => expect(screen.getByRole("button", { name: "18" })).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "18" }));
    });
    expect(screen.queryByLabelText("Calendar event editor")).not.toBeInTheDocument();
  });

  it("opens day view from the more events control", async () => {
    renderCalendar();
    await waitFor(() => expect(screen.getByRole("button", { name: "3 more" })).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "3 more" }));
    });
    expect(screen.getByRole("button", { name: "Day" })).toHaveClass("secondary-link-active");
    expect(screen.getByLabelText("Calendar date")).toHaveValue("2026-07-15");
  });

  it("shows a dated next event and the number of additional future events", async () => {
    renderCalendar();

    await waitFor(() => expect(screen.getByText("Next event")).toBeInTheDocument());
    expect(screen.getByText("July 15, 2026 · All day")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "5 more upcoming events" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "5 more upcoming events" }));
    expect(within(screen.getByLabelText("Upcoming events")).getByRole("button", { name: /Planning/ })).toBeInTheDocument();
  });

  it("formats all-day and timed event dates in the details panel", async () => {
    renderCalendar();
    await waitFor(() => expect(screen.getByText("Next event")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const allDayDetails = screen.getByLabelText("Office party");
    expect(within(allDayDetails).getByText("Date and time")).toBeInTheDocument();
    expect(within(allDayDetails).getByText("July 15, 2026 · All day")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: /^Planning, / }));
    expect(within(screen.getByLabelText("Planning")).getByText(/July 15, 2026 · .*-.*/)).toBeInTheDocument();
  });

  it("preserves the selected date while switching calendar views", async () => {
    renderCalendar();
    await waitFor(() => expect(screen.getByLabelText("Calendar date")).toHaveValue("2026-07-14"));
    fireEvent.change(screen.getByLabelText("Calendar date"), { target: { value: "2026-07-27" } });

    for (const viewName of ["Agenda", "Day", "Week", "Month"]) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: viewName }));
      });
      expect(screen.getByLabelText("Calendar date")).toHaveValue("2026-07-27");
    }
  });

  it("shows cancelled event restore action and hides edit/join", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderCalendar();
    await waitFor(() => expect(screen.getAllByText("Cancelled sync")[0]).toBeInTheDocument());

    fireEvent.click(screen.getAllByText("Cancelled sync")[0]);

    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Join/ })).not.toBeInTheDocument();
    expect(screen.getByText("No longer needed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore event" }));
    await waitFor(() => expect(apiMocks.restoreCalendarEvent).toHaveBeenCalledWith("token", "event-cancelled"));
  });

  it("shows agenda grouping, upcoming block, and RU navigation labels", async () => {
    renderCalendar("superadmin", ru);
    fireEvent.click(screen.getByRole("button", { name: "Список" }));

    await waitFor(() => expect(screen.getByText("Ближайшее событие")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Назад" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Вперёд" })).toBeInTheDocument();
    expect(screen.getAllByText("Сегодня").length).toBeGreaterThan(0);
    expect(screen.getByText("Завтра")).toBeInTheDocument();
  });
});
