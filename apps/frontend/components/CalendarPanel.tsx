"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Dictionary, Locale } from "../lib/i18n";
import {
  cancelCalendarEvent,
  createCalendarEvent,
  getCalendarEvents,
  hasPermission,
  previewCalendarAudience,
  restoreCalendarEvent,
  updateCalendarEvent,
  type CalendarAudiencePreview,
  type CalendarAudienceType,
  type CalendarEventPayload,
  type CalendarEventType,
  type OfficeChatCalendarEvent,
  type OfficeChatDirectoryUser,
  type OfficeChatGroup,
  type OfficeChatUser
} from "../lib/api";
import { getStoredAccessToken } from "../lib/session";

type CalendarView = "agenda" | "day" | "week" | "month";

type CalendarPanelProps = {
  currentUser: OfficeChatUser;
  dictionary: Dictionary;
  groups: OfficeChatGroup[];
  locale: Locale;
  users: OfficeChatDirectoryUser[];
  externalEvent?: OfficeChatCalendarEvent | null;
};

const calendarViewKey = "officechat.calendar.view";
const eventTypes: CalendarEventType[] = ["meeting", "video_conference", "office_event", "training", "maintenance", "other"];
const audienceTypes: CalendarAudienceType[] = ["all_active_users", "selected_groups", "selected_users"];
const reminderOptions = [0, 15, 30, 60, 1440];
const monthEventLimit = 3;
const calendarStartHour = 7;
const calendarEndHour = 20;

type AudienceOption = {
  id: string;
  label: string;
  meta: string;
};

function formatDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromInput(value: string) {
  return new Date(`${value}T00:00:00`);
}

function startOfWeek(date: Date) {
  const copy = new Date(date);
  const day = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - day);
  return copy;
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function addMonths(date: Date, months: number) {
  const copy = new Date(date);
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

function monthRange(anchor: Date) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const end = addDays(startOfWeek(last), 6);
  return { start, end };
}

function toLocalDateTimeValue(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function dateTimeValueForDate(date: Date, hour = 9) {
  const copy = new Date(date);
  copy.setHours(hour, 0, 0, 0);
  return toLocalDateTimeValue(copy.toISOString());
}

function fromLocalDateTimeValue(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function safeHostname(url: string | null) {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function reminderLabel(dictionary: Dictionary, minutes: number) {
  const key = String(minutes) as keyof typeof dictionary.calendar.reminderLabels;
  return dictionary.calendar.reminderLabels[key] ?? `${minutes} min`;
}

function matchesAudienceSearch(option: AudienceOption, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${option.label} ${option.meta}`.toLowerCase().includes(normalized);
}

function eventOccursOn(event: OfficeChatCalendarEvent, dateValue: string) {
  if (event.is_all_day) {
    return Boolean(event.all_day_start_date && event.all_day_end_date && event.all_day_start_date <= dateValue && event.all_day_end_date >= dateValue);
  }
  const starts = event.starts_at ? formatDateInput(new Date(event.starts_at)) : "";
  const ends = event.ends_at ? formatDateInput(new Date(event.ends_at)) : starts;
  return starts <= dateValue && ends >= dateValue;
}

function eventSortValue(event: OfficeChatCalendarEvent) {
  if (event.is_all_day) return event.all_day_start_date ?? "";
  return event.starts_at ?? "";
}

function currentTimePercent() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = calendarStartHour * 60;
  const end = calendarEndHour * 60;
  return Math.min(100, Math.max(0, ((minutes - start) / (end - start)) * 100));
}

function createInitialForm(timezone: string): CalendarEventPayload {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const later = new Date(now.getTime() + 60 * 60_000);
  return {
    title: "",
    description: "",
    event_type: "meeting",
    is_all_day: false,
    starts_at: toLocalDateTimeValue(now.toISOString()),
    ends_at: toLocalDateTimeValue(later.toISOString()),
    all_day_start_date: formatDateInput(now),
    all_day_end_date: formatDateInput(now),
    timezone,
    location: "",
    conference_url: "",
    audience_type: "selected_users",
    group_ids: [],
    user_ids: [],
    reminder_minutes: [15]
  };
}

export function CalendarPanel({ currentUser, dictionary, groups, locale, users, externalEvent }: CalendarPanelProps) {
  const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";
  const [view, setView] = useState<CalendarView>(() => {
    if (typeof window === "undefined") return "agenda";
    return (localStorage.getItem(calendarViewKey) as CalendarView | null) ?? (window.innerWidth < 900 ? "agenda" : "month");
  });
  const [anchorDate, setAnchorDate] = useState(() => new Date());
  const [events, setEvents] = useState<OfficeChatCalendarEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<OfficeChatCalendarEvent | null>(null);
  const [form, setForm] = useState<CalendarEventPayload>(() => createInitialForm(defaultTimezone));
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [preview, setPreview] = useState<CalendarAudiencePreview | null>(null);
  const [isPreviewStale, setIsPreviewStale] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groupSearch, setGroupSearch] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [activeAudienceHelp, setActiveAudienceHelp] = useState<"groups" | "users" | null>(null);
  const detailsOpenButtonRef = useRef<HTMLElement | null>(null);
  const editorOpenButtonRef = useRef<HTMLElement | null>(null);

  const canManageCalendar = currentUser.role === "superadmin" || hasPermission(currentUser, "can_manage_calendar");
  const formatter = useMemo(
    () => new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", { dateStyle: "medium", timeStyle: "short" }),
    [locale]
  );
  const dayFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", { weekday: "short", day: "numeric", month: "short" }),
    [locale]
  );
  const groupOptions = useMemo<AudienceOption[]>(
    () => groups.map((group) => ({ id: group.id, label: group.name, meta: group.slug })),
    [groups]
  );
  const userOptions = useMemo<AudienceOption[]>(
    () =>
      users
        .filter((user) => user.id !== currentUser.id && user.role !== "bot" && user.is_active)
        .map((user) => ({ id: user.id, label: user.display_name, meta: `@${user.username}` })),
    [currentUser.id, users]
  );

  const range = useMemo(() => {
    if (view === "day") return { start: anchorDate, end: anchorDate };
    if (view === "week") return { start: startOfWeek(anchorDate), end: addDays(startOfWeek(anchorDate), 6) };
    if (view === "month") return monthRange(anchorDate);
    return { start: anchorDate, end: addDays(anchorDate, 30) };
  }, [anchorDate, view]);

  const todayValue = formatDateInput(new Date());
  const selectedDateValue = formatDateInput(anchorDate);

  const loadEvents = useCallback(async () => {
    const token = getStoredAccessToken();
    if (!token) return;
    setIsLoading(true);
    setError(null);
    try {
      const page = await getCalendarEvents(token, {
        date_from: formatDateInput(range.start),
        date_to: formatDateInput(range.end),
        include_cancelled: true,
        limit: 500
      });
      setEvents(page.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : dictionary.calendar.loadError);
    } finally {
      setIsLoading(false);
    }
  }, [dictionary.calendar.loadError, range.end, range.start]);

  useEffect(() => {
    localStorage.setItem(calendarViewKey, view);
  }, [view]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    if (!activeAudienceHelp && !selectedEvent && !isEditorOpen) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (selectedEvent) {
        setSelectedEvent(null);
        detailsOpenButtonRef.current?.focus();
      } else if (isEditorOpen) {
        setIsEditorOpen(false);
        editorOpenButtonRef.current?.focus();
      } else {
        setActiveAudienceHelp(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeAudienceHelp, isEditorOpen, selectedEvent]);

  useEffect(() => {
    if (!externalEvent) return;
    setEvents((current) => {
      const next = current.filter((item) => item.id !== externalEvent.id);
      return [...next, externalEvent].sort((a, b) => eventSortValue(a).localeCompare(eventSortValue(b)));
    });
  }, [externalEvent]);

  function updateForm(patch: Partial<CalendarEventPayload>) {
    setForm((current) => ({ ...current, ...patch }));
    setIsPreviewStale(true);
    setPreview(null);
  }

  function openCreateForm(date: Date = anchorDate, hour = 9, opener?: HTMLElement | null) {
    const startsAt = dateTimeValueForDate(date, hour);
    const endsAt = dateTimeValueForDate(date, hour + 1);
    editorOpenButtonRef.current = opener ?? null;
    setEditingEventId(null);
    setForm({
      ...createInitialForm(defaultTimezone),
      starts_at: startsAt,
      ends_at: endsAt,
      all_day_start_date: formatDateInput(date),
      all_day_end_date: formatDateInput(date),
    });
    setPreview(null);
    setIsPreviewStale(false);
    setIsEditorOpen(true);
    setMessage(null);
    setError(null);
    setGroupSearch("");
    setUserSearch("");
    setActiveAudienceHelp(null);
  }

  function openEditForm(event: OfficeChatCalendarEvent, opener?: HTMLElement | null) {
    editorOpenButtonRef.current = opener ?? null;
    setEditingEventId(event.id);
    setForm({
      title: event.title,
      description: event.description ?? "",
      event_type: event.event_type,
      is_all_day: event.is_all_day,
      starts_at: toLocalDateTimeValue(event.starts_at),
      ends_at: toLocalDateTimeValue(event.ends_at),
      all_day_start_date: event.all_day_start_date,
      all_day_end_date: event.all_day_end_date,
      timezone: event.timezone,
      location: event.location ?? "",
      conference_url: event.conference_url ?? "",
      audience_type: event.audience_summary.type,
      group_ids: event.editable_audience?.group_ids ?? [],
      user_ids: event.editable_audience?.user_ids ?? [],
      reminder_minutes: event.reminder_minutes
    });
    setPreview(null);
    setIsPreviewStale(false);
    setIsEditorOpen(true);
    setMessage(null);
    setError(null);
    setGroupSearch("");
    setUserSearch("");
    setActiveAudienceHelp(null);
  }

  function openEventDetails(event: OfficeChatCalendarEvent, opener?: HTMLElement | null) {
    detailsOpenButtonRef.current = opener ?? null;
    setSelectedEvent(event);
  }

  function closeEventDetails() {
    setSelectedEvent(null);
    detailsOpenButtonRef.current?.focus();
  }

  function closeEditor() {
    setIsEditorOpen(false);
    editorOpenButtonRef.current?.focus();
  }

  function toggleSelection(field: "group_ids" | "user_ids", optionId: string, checked: boolean) {
    const current = new Set(form[field] ?? []);
    if (checked) current.add(optionId);
    else current.delete(optionId);
    updateForm({ [field]: Array.from(current) } as Partial<CalendarEventPayload>);
  }

  function renderAudienceSelector(
    field: "group_ids" | "user_ids",
    label: string,
    options: AudienceOption[],
    searchValue: string,
    setSearchValue: (value: string) => void,
    helpKey: "groups" | "users"
  ) {
    const selected = new Set(form[field] ?? []);
    const filtered = options.filter((option) => matchesAudienceSearch(option, searchValue));
    const selectedOptions = options.filter((option) => selected.has(option.id));
    const helpText = helpKey === "groups" ? dictionary.calendar.audienceHelp.groups : dictionary.calendar.audienceHelp.users;
    return (
      <fieldset className="field calendar-form-wide calendar-audience-selector">
        <legend className="field-label calendar-audience-legend">
          <span>{label}</span>
          <button
            aria-expanded={activeAudienceHelp === helpKey}
            aria-label={dictionary.calendar.audienceHelp.open}
            className="icon-button small-icon-button"
            onClick={() => setActiveAudienceHelp((current) => (current === helpKey ? null : helpKey))}
            title={dictionary.calendar.audienceHelp.open}
            type="button"
          >
            ?
          </button>
        </legend>
        {activeAudienceHelp === helpKey ? <p className="note calendar-audience-help">{helpText}</p> : null}
        <div className="calendar-audience-toolbar">
          <input
            aria-label={dictionary.calendar.audienceSearch}
            className="field-input"
            onChange={(event) => setSearchValue(event.target.value)}
            placeholder={dictionary.calendar.audienceSearch}
            value={searchValue}
          />
          <span className="calendar-selected-count">
            {dictionary.calendar.selectedCount.replace("{count}", String(selected.size))}
          </span>
        </div>
        {selectedOptions.length ? (
          <div className="calendar-selection-chips" aria-label={dictionary.calendar.selectedItems}>
            {selectedOptions.slice(0, 4).map((option) => (
              <span className="calendar-selection-chip" key={option.id}>{option.label}</span>
            ))}
            {selectedOptions.length > 4 ? (
              <span className="calendar-selection-chip">
                {dictionary.calendar.moreSelected.replace("{count}", String(selectedOptions.length - 4))}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="calendar-audience-actions">
          <button
            className="secondary-link compact-button"
            disabled={!filtered.length}
            onClick={() => updateForm({ [field]: Array.from(new Set([...(form[field] ?? []), ...filtered.map((option) => option.id)])) } as Partial<CalendarEventPayload>)}
            type="button"
          >
            {dictionary.calendar.selectFiltered}
          </button>
          <button
            className="secondary-link compact-button"
            disabled={!selected.size}
            onClick={() => updateForm({ [field]: [] } as Partial<CalendarEventPayload>)}
            type="button"
          >
            {dictionary.calendar.clearSelection}
          </button>
        </div>
        <div className="calendar-checkbox-list">
          {filtered.length ? filtered.map((option) => (
            <label className="calendar-checkbox-option" key={option.id}>
              <input
                checked={selected.has(option.id)}
                onChange={(event) => toggleSelection(field, option.id, event.target.checked)}
                type="checkbox"
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.meta}</small>
              </span>
            </label>
          )) : <p className="muted">{dictionary.calendar.noAudienceResults}</p>}
        </div>
      </fieldset>
    );
  }

  function buildPayload(): CalendarEventPayload {
    return {
      ...form,
      title: form.title.trim(),
      description: form.description?.trim() || null,
      location: form.location?.trim() || null,
      conference_url: form.conference_url?.trim() || null,
      starts_at: form.is_all_day ? null : fromLocalDateTimeValue(form.starts_at || ""),
      ends_at: form.is_all_day ? null : fromLocalDateTimeValue(form.ends_at || ""),
      all_day_start_date: form.is_all_day ? form.all_day_start_date : null,
      all_day_end_date: form.is_all_day ? form.all_day_end_date : null,
      timezone: form.timezone || defaultTimezone,
      group_ids: form.audience_type === "selected_groups" ? form.group_ids ?? [] : [],
      user_ids: form.audience_type === "selected_users" ? form.user_ids ?? [] : []
    };
  }

  async function handlePreviewAudience() {
    const token = getStoredAccessToken();
    if (!token) return;
    try {
      const payload = buildPayload();
      setPreview(await previewCalendarAudience(token, {
        audience_type: payload.audience_type,
        group_ids: payload.group_ids,
        user_ids: payload.user_ids
      }));
      setIsPreviewStale(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : dictionary.calendar.previewError);
    }
  }

  async function handleSave() {
    const token = getStoredAccessToken();
    if (!token) return;
    setIsSaving(true);
    setError(null);
    try {
      const payload = buildPayload();
      const saved = editingEventId
        ? await updateCalendarEvent(token, editingEventId, payload)
        : await createCalendarEvent(token, payload);
      setMessage(editingEventId ? dictionary.calendar.updateSuccess : dictionary.calendar.createSuccess);
      setSelectedEvent(saved);
      setIsEditorOpen(false);
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : dictionary.calendar.saveError);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCancelEvent(event: OfficeChatCalendarEvent) {
    const token = getStoredAccessToken();
    if (!token) return;
    try {
      const reason = window.prompt(dictionary.calendar.cancellationReason) ?? null;
      const cancelled = await cancelCalendarEvent(token, event.id, reason);
      setSelectedEvent(cancelled);
      setMessage(dictionary.calendar.cancelSuccess);
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : dictionary.calendar.cancelError);
    }
  }

  async function handleRestoreEvent(event: OfficeChatCalendarEvent) {
    const token = getStoredAccessToken();
    if (!token) return;
    if (!window.confirm(dictionary.calendar.restoreConfirm)) return;
    try {
      const restored = await restoreCalendarEvent(token, event.id);
      setSelectedEvent(restored);
      setMessage(dictionary.calendar.restoreSuccess);
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : dictionary.calendar.restoreError);
    }
  }

  function moveCalendar(direction: -1 | 1) {
    if (view === "day") setAnchorDate((current) => addDays(current, direction));
    else if (view === "week") setAnchorDate((current) => addDays(current, direction * 7));
    else if (view === "month") setAnchorDate((current) => addMonths(current, direction));
    else setAnchorDate((current) => addDays(current, direction * 30));
  }

  function handleDateClick(dateValue: string, hour = 9, opener?: HTMLElement | null) {
    const date = dateFromInput(dateValue);
    setAnchorDate(date);
    if (canManageCalendar) {
      openCreateForm(date, hour, opener);
    }
  }

  const isSaveDisabled = isSaving || (form.audience_type === "all_active_users" && isPreviewStale);

  const eventsByDate = useMemo(() => {
    const grouped = new Map<string, OfficeChatCalendarEvent[]>();
    for (let cursor = new Date(range.start); cursor <= range.end; cursor = addDays(cursor, 1)) {
      const key = formatDateInput(cursor);
      grouped.set(key, events.filter((event) => eventOccursOn(event, key)));
    }
    return grouped;
  }, [events, range.end, range.start]);

  const nearestVisibleEvent = useMemo(() => {
    const now = Date.now();
    return [...events]
      .filter((event) => event.status !== "cancelled")
      .filter((event) => {
        const value = event.is_all_day ? event.all_day_start_date : event.starts_at;
        return value ? new Date(event.is_all_day ? `${value}T00:00:00` : value).getTime() >= now : false;
      })
      .sort((a, b) => eventSortValue(a).localeCompare(eventSortValue(b)))[0] ?? null;
  }, [events]);

  function renderEventTime(event: OfficeChatCalendarEvent) {
    if (event.is_all_day) return dictionary.calendar.allDay;
    if (!event.starts_at || !event.ends_at) return "";
    return `${formatter.format(new Date(event.starts_at))} - ${formatter.format(new Date(event.ends_at))}`;
  }

  function eventStatusLabel(event: OfficeChatCalendarEvent) {
    if (event.status === "cancelled" || event.status === "rescheduled") {
      return dictionary.calendar.statuses[event.status];
    }
    return null;
  }

  function eventTypeIcon(type: CalendarEventType) {
    const icons: Record<CalendarEventType, string> = {
      meeting: "M",
      video_conference: "V",
      office_event: "O",
      training: "T",
      maintenance: "!",
      other: "*",
    };
    return icons[type];
  }

  function renderEventChip(event: OfficeChatCalendarEvent) {
    return (
      <button
        className={`calendar-event-chip calendar-event-${event.status}`}
        key={event.id}
        onClick={(clickEvent) => openEventDetails(event, clickEvent.currentTarget)}
        title={`${event.title} - ${dictionary.calendar.eventTypes[event.event_type]}`}
        type="button"
      >
        <span className="calendar-event-meta">
          <span className="calendar-type-icon" aria-hidden="true">{eventTypeIcon(event.event_type)}</span>
          <span>{event.is_all_day ? dictionary.calendar.allDay : new Date(event.starts_at ?? "").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          {eventStatusLabel(event) ? <span className="calendar-status-pill">{eventStatusLabel(event)}</span> : null}
        </span>
        <strong>{event.title}</strong>
        <small>{dictionary.calendar.eventTypes[event.event_type]}{event.location ? ` - ${event.location}` : event.conference_url ? ` - ${dictionary.calendar.video}` : ""}</small>
      </button>
    );
  }

  function renderAgenda() {
    return (
      <div className="calendar-agenda">
        {Array.from(eventsByDate.entries()).map(([dateValue, dayEvents]) => (
          <section className="calendar-agenda-day" key={dateValue}>
            <h3>
              {dateValue === todayValue
                ? dictionary.calendar.today
                : dateValue === formatDateInput(addDays(new Date(), 1))
                  ? dictionary.calendar.tomorrow
                  : dayFormatter.format(dateFromInput(dateValue))}
            </h3>
            {dayEvents.length ? dayEvents.map(renderEventChip) : <p className="muted">{dictionary.calendar.noEventsForDate}</p>}
          </section>
        ))}
      </div>
    );
  }

  function renderMonth() {
    return (
      <div className="calendar-month-grid">
        {Array.from(eventsByDate.entries()).map(([dateValue, dayEvents]) => (
          <div
            className={`calendar-month-cell${dateValue === todayValue ? " calendar-date-today" : ""}${dateValue === selectedDateValue ? " calendar-date-selected" : ""}`}
            key={dateValue}
          >
            <button
              aria-current={dateValue === todayValue ? "date" : undefined}
              className="calendar-date-button"
              onClick={(event) => handleDateClick(dateValue, 9, event.currentTarget)}
              type="button"
            >
              {dateFromInput(dateValue).getDate()}
            </button>
            {dayEvents.slice(0, monthEventLimit).map(renderEventChip)}
            {dayEvents.length > monthEventLimit ? (
              <button
                className="calendar-more"
                onClick={() => {
                  setAnchorDate(dateFromInput(dateValue));
                  setView("day");
                }}
                type="button"
              >
                {dictionary.calendar.more.replace("{count}", String(dayEvents.length - monthEventLimit))}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    );
  }

  function renderLinearView() {
    const hours = Array.from({ length: calendarEndHour - calendarStartHour + 1 }, (_, index) => calendarStartHour + index);
    return (
      <div className="calendar-time-grid">
        {Array.from(eventsByDate.entries()).map(([dateValue, dayEvents]) => (
          <section className={`calendar-time-day${dateValue === todayValue ? " calendar-date-today" : ""}`} key={dateValue}>
            <h3>{dayFormatter.format(new Date(`${dateValue}T00:00:00`))}</h3>
            <div className="calendar-all-day-strip">
              {dayEvents.filter((event) => event.is_all_day).map(renderEventChip)}
            </div>
            <div className="calendar-hour-grid">
              {dateValue === todayValue ? <span className="calendar-current-time" style={{ top: `${currentTimePercent()}%` }} /> : null}
              {hours.map((hour) => {
                const hourEvents = dayEvents.filter((event) => {
                  if (event.is_all_day || !event.starts_at) return false;
                  const date = new Date(event.starts_at);
                  return date.getHours() === hour;
                });
                return (
                  <div
                    className="calendar-hour-row"
                    key={hour}
                    onClick={(event) => handleDateClick(dateValue, hour, event.currentTarget)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleDateClick(dateValue, hour, event.currentTarget);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <span className="calendar-hour-label">{String(hour).padStart(2, "0")}:00</span>
                    <span className="calendar-hour-events" onClick={(event) => event.stopPropagation()}>
                      {hourEvents.map(renderEventChip)}
                    </span>
                  </div>
                );
              })}
            </div>
            {!dayEvents.length ? <p className="muted">{dictionary.calendar.noEventsForDate}</p> : null}
          </section>
        ))}
      </div>
    );
  }

  return (
    <section className="calendar-panel" aria-label={dictionary.calendar.title}>
      <div className="calendar-toolbar">
        <div>
          <h2 className="section-title">{dictionary.calendar.title}</h2>
          <p className="admin-current">{dictionary.calendar.subtitle}</p>
        </div>
        {nearestVisibleEvent ? (
          <div className="calendar-next-event">
            <span>{dictionary.calendar.nextEvent}</span>
            <strong>{nearestVisibleEvent.title}</strong>
            <small>{renderEventTime(nearestVisibleEvent)} - {dictionary.calendar.eventTypes[nearestVisibleEvent.event_type]}</small>
            <div className="calendar-next-actions">
              <button className="secondary-link compact-button" onClick={(event) => openEventDetails(nearestVisibleEvent, event.currentTarget)} type="button">{dictionary.calendar.open}</button>
              {nearestVisibleEvent.conference_url ? (
                <a className="secondary-link compact-button" href={nearestVisibleEvent.conference_url} rel="noopener noreferrer" target="_blank">{dictionary.calendar.join}</a>
              ) : null}
            </div>
          </div>
        ) : <p className="calendar-next-event muted">{dictionary.calendar.noUpcomingEvents}</p>}
        <div className="calendar-toolbar-actions">
          <button className="secondary-link" onClick={() => moveCalendar(-1)} type="button">{dictionary.calendar.previous}</button>
          <button className="secondary-link" onClick={() => setAnchorDate(new Date())} type="button">{dictionary.calendar.today}</button>
          <button className="secondary-link" onClick={() => moveCalendar(1)} type="button">{dictionary.calendar.next}</button>
          <input
            aria-label={dictionary.calendar.anchorDate}
            className="field-input"
            onChange={(event) => setAnchorDate(dateFromInput(event.target.value))}
            type="date"
            value={formatDateInput(anchorDate)}
          />
          {(["agenda", "day", "week", "month"] as CalendarView[]).map((item) => (
            <button className={view === item ? "secondary-link secondary-link-active" : "secondary-link"} key={item} onClick={() => setView(item)} type="button">
              {dictionary.calendar.views[item]}
            </button>
          ))}
          <button className="secondary-link" onClick={() => void loadEvents()} type="button">{dictionary.calendar.refresh}</button>
          {canManageCalendar ? <button className="primary-button" onClick={(event) => openCreateForm(anchorDate, 9, event.currentTarget)} type="button">{dictionary.calendar.create}</button> : null}
        </div>
      </div>
      {message ? <p className="form-success">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      {isLoading ? <p className="muted">{dictionary.calendar.loading}</p> : null}
      {view === "month" ? renderMonth() : view === "agenda" ? renderAgenda() : renderLinearView()}

      {selectedEvent ? (
        <div className="settings-backdrop" role="presentation">
          <section className="settings-panel calendar-detail-panel" aria-label={selectedEvent.title}>
            <div className="settings-panel-header">
              <h2 className="section-title">{selectedEvent.title}</h2>
              <button className="secondary-link" onClick={closeEventDetails} type="button">{dictionary.calendar.close}</button>
            </div>
            <dl className="calendar-detail-list">
              <dt>{dictionary.calendar.type}</dt><dd>{dictionary.calendar.eventTypes[selectedEvent.event_type]}</dd>
              <dt>{dictionary.calendar.status}</dt><dd>{dictionary.calendar.statuses[selectedEvent.status]}</dd>
              <dt>{dictionary.calendar.time}</dt><dd>{renderEventTime(selectedEvent)}</dd>
              <dt>{dictionary.calendar.timezone}</dt><dd>{selectedEvent.timezone}</dd>
              <dt>{dictionary.calendar.location}</dt><dd>{selectedEvent.location || dictionary.calendar.emptyValue}</dd>
              <dt>{dictionary.calendar.organizer}</dt><dd>{selectedEvent.created_by.display_name || selectedEvent.created_by.username || dictionary.calendar.emptyValue}</dd>
              <dt>{dictionary.calendar.recipients}</dt><dd>{selectedEvent.audience_summary.recipient_count}</dd>
              <dt>{dictionary.calendar.reminders}</dt><dd>{selectedEvent.reminder_minutes.length ? selectedEvent.reminder_minutes.map((item) => reminderLabel(dictionary, item)).join(", ") : dictionary.calendar.noReminders}</dd>
              {selectedEvent.cancelled_at ? <><dt>{dictionary.calendar.cancelledAt}</dt><dd>{formatter.format(new Date(selectedEvent.cancelled_at))}</dd></> : null}
              {selectedEvent.cancellation_reason ? <><dt>{dictionary.calendar.cancellationReason}</dt><dd>{selectedEvent.cancellation_reason}</dd></> : null}
            </dl>
            {selectedEvent.description ? <p className="calendar-description">{selectedEvent.description}</p> : null}
            {selectedEvent.conference_url && selectedEvent.status !== "cancelled" ? (
              <a className="primary-button" href={selectedEvent.conference_url} rel="noopener noreferrer" target="_blank">
                {dictionary.calendar.join} ({safeHostname(selectedEvent.conference_url)})
              </a>
            ) : null}
            {selectedEvent.status === "cancelled" ? <p className="form-error">{dictionary.calendar.cancelledNotice}</p> : null}
            {selectedEvent.can_manage ? (
              <div className="actions">
                {selectedEvent.status !== "cancelled" ? (
                  <>
                    <button className="secondary-link" onClick={(event) => openEditForm(selectedEvent, event.currentTarget)} type="button">{dictionary.calendar.edit}</button>
                    <button className="secondary-link" onClick={() => void handleCancelEvent(selectedEvent)} type="button">{dictionary.calendar.cancelEvent}</button>
                  </>
                ) : (
                  <button className="secondary-link" onClick={() => void handleRestoreEvent(selectedEvent)} type="button">{dictionary.calendar.restoreEvent}</button>
                )}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {isEditorOpen ? (
        <div className="settings-backdrop" role="presentation">
          <section className="settings-panel calendar-editor-panel" aria-label={dictionary.calendar.editorTitle}>
            <div className="settings-panel-header">
              <h2 className="section-title">{editingEventId ? dictionary.calendar.edit : dictionary.calendar.create}</h2>
              <button className="secondary-link" onClick={closeEditor} type="button">{dictionary.calendar.close}</button>
            </div>
            <div className="calendar-form-grid">
              <label className="field"><span className="field-label">{dictionary.calendar.fields.title}</span><input className="field-input" onChange={(event) => updateForm({ title: event.target.value })} value={form.title} /></label>
              <label className="field"><span className="field-label">{dictionary.calendar.fields.type}</span><select className="field-input" onChange={(event) => updateForm({ event_type: event.target.value as CalendarEventType })} value={form.event_type}>{eventTypes.map((item) => <option key={item} value={item}>{dictionary.calendar.eventTypes[item]}</option>)}</select></label>
              <label className="checkbox-field"><input checked={form.is_all_day} onChange={(event) => updateForm({ is_all_day: event.target.checked })} type="checkbox" /> <span>{dictionary.calendar.allDay}</span></label>
              {form.is_all_day ? (
                <>
                  <label className="field"><span className="field-label">{dictionary.calendar.fields.startDate}</span><input className="field-input" onChange={(event) => updateForm({ all_day_start_date: event.target.value })} type="date" value={form.all_day_start_date ?? ""} /></label>
                  <label className="field"><span className="field-label">{dictionary.calendar.fields.endDate}</span><input className="field-input" onChange={(event) => updateForm({ all_day_end_date: event.target.value })} type="date" value={form.all_day_end_date ?? ""} /></label>
                </>
              ) : (
                <>
                  <label className="field"><span className="field-label">{dictionary.calendar.fields.startsAt}</span><input className="field-input" onChange={(event) => updateForm({ starts_at: event.target.value })} type="datetime-local" value={form.starts_at ?? ""} /></label>
                  <label className="field"><span className="field-label">{dictionary.calendar.fields.endsAt}</span><input className="field-input" onChange={(event) => updateForm({ ends_at: event.target.value })} type="datetime-local" value={form.ends_at ?? ""} /></label>
                </>
              )}
              <label className="field"><span className="field-label">{dictionary.calendar.fields.timezone}</span><input className="field-input" onChange={(event) => updateForm({ timezone: event.target.value })} value={form.timezone ?? ""} /></label>
              <label className="field"><span className="field-label">{dictionary.calendar.fields.location}</span><input className="field-input" onChange={(event) => updateForm({ location: event.target.value })} value={form.location ?? ""} /></label>
              <label className="field"><span className="field-label">{dictionary.calendar.fields.conferenceUrl}</span><input className="field-input" onChange={(event) => updateForm({ conference_url: event.target.value })} value={form.conference_url ?? ""} /></label>
              <label className="field calendar-form-wide"><span className="field-label">{dictionary.calendar.fields.description}</span><textarea className="field-input" onChange={(event) => updateForm({ description: event.target.value })} rows={4} value={form.description ?? ""} /></label>
              <label className="field"><span className="field-label">{dictionary.calendar.fields.audience}</span><select className="field-input" onChange={(event) => updateForm({ audience_type: event.target.value as CalendarAudienceType, group_ids: [], user_ids: [] })} value={form.audience_type}>{audienceTypes.map((item) => <option key={item} value={item}>{dictionary.calendar.audienceTypes[item]}</option>)}</select></label>
              {form.audience_type === "selected_groups" ? (
                renderAudienceSelector("group_ids", dictionary.calendar.fields.groups, groupOptions, groupSearch, setGroupSearch, "groups")
              ) : null}
              {form.audience_type === "selected_users" ? (
                renderAudienceSelector("user_ids", dictionary.calendar.fields.users, userOptions, userSearch, setUserSearch, "users")
              ) : null}
              <fieldset className="field calendar-form-wide">
                <legend className="field-label">{dictionary.calendar.fields.reminders}</legend>
                <div className="calendar-reminder-options">
                  {reminderOptions.map((minutes) => (
                    <label className="checkbox-field" key={minutes}>
                      <input
                        checked={form.reminder_minutes?.includes(minutes) ?? false}
                        onChange={(event) => {
                          const current = new Set(form.reminder_minutes ?? []);
                          if (event.target.checked) current.add(minutes);
                          else current.delete(minutes);
                          updateForm({ reminder_minutes: Array.from(current) });
                        }}
                        type="checkbox"
                      />
                      <span>{reminderLabel(dictionary, minutes)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="actions">
              <button className="secondary-link" onClick={() => void handlePreviewAudience()} type="button">{dictionary.calendar.previewAudience}</button>
              <button className="primary-button" disabled={isSaveDisabled} onClick={() => void handleSave()} type="button">{isSaving ? dictionary.calendar.saving : dictionary.calendar.save}</button>
            </div>
            {preview ? <p className="form-success">{dictionary.calendar.previewCount.replace("{count}", String(preview.recipient_count))}</p> : null}
            {isPreviewStale ? <p className="note">{dictionary.calendar.previewStale}</p> : null}
          </section>
        </div>
      ) : null}
    </section>
  );
}
