import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminAudit } from "../components/AdminAudit";
import { AdminUsers } from "../components/AdminUsers";
import en from "../dictionaries/en.json";
import ru from "../dictionaries/ru.json";
import { auditEventFactory, userFactory } from "./factories";

const apiMocks = vi.hoisted(() => ({
  getAdminPermissions: vi.fn(),
  getAdminUserPermissions: vi.fn(),
  getAdminUsers: vi.fn(),
  getAuditEvent: vi.fn(),
  getAuditEvents: vi.fn(),
  getAuditFilters: vi.fn(),
  getCurrentUser: vi.fn(),
  getStoredAccessToken: vi.fn(() => "test-token"),
  requireStoredAccessToken: vi.fn(() => "test-token"),
  updateAdminUser: vi.fn(),
  updateAdminUserPermissions: vi.fn()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() })
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, ...apiMocks };
});

const admin = userFactory({
  id: "00000000-0000-4000-8000-000000000099",
  username: "admin",
  display_name: "OfficeChat Admin",
  role: "admin"
});

describe("admin page smoke coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.requireStoredAccessToken.mockReturnValue("test-token");
    apiMocks.getStoredAccessToken.mockReturnValue("test-token");
    apiMocks.getCurrentUser.mockResolvedValue(admin);
    apiMocks.getAdminPermissions.mockResolvedValue([]);
    apiMocks.getAdminUserPermissions.mockResolvedValue({
      explicit_permissions: [],
      effective_permissions: [],
      inherited_from_superadmin: false
    });
    apiMocks.updateAdminUserPermissions.mockResolvedValue({
      explicit_permissions: ["can_pin_messages"],
      effective_permissions: ["can_pin_messages"],
      inherited_from_superadmin: false
    });
    apiMocks.updateAdminUser.mockImplementation((_token: string, _userId: string, payload: object) =>
      Promise.resolve(userFactory(payload))
    );
  });

  it("renders a large user set and opens the selected row editor", async () => {
    const users = Array.from({ length: 75 }, (_, index) =>
      userFactory({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        username: `employee_${index + 1}`,
        display_name: `Employee ${index + 1}`,
        email: `employee_${index + 1}@example.test`
      })
    );
    apiMocks.getAdminUsers.mockResolvedValue(users);

    render(<AdminUsers dictionary={en} locale="en" />);

    const targetName = "Employee 75";
    await screen.findAllByText(targetName);
    const targetRow = screen
      .getAllByText(targetName)
      .map((element) => element.closest("tr"))
      .find((row): row is HTMLTableRowElement => row !== null);

    expect(targetRow).toBeDefined();
    fireEvent.click(targetRow!);

    const dialog = await screen.findByRole("dialog", { name: en.adminUsers.editTitle });
    expect(within(dialog).getByDisplayValue("employee_75")).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue(targetName)).toBeInTheDocument();
  });

  it("loads an audit event and opens long details in a named dialog", async () => {
    const event = auditEventFactory();
    apiMocks.getAuditEvents.mockResolvedValue({ items: [event], total: 1, page: 1, limit: 50 });
    apiMocks.getAuditFilters.mockResolvedValue({
      categories: ["admin"],
      statuses: ["success"],
      event_types: [event.event_type]
    });
    apiMocks.getAuditEvent.mockResolvedValue(event);

    render(<AdminAudit dictionary={ru} locale="ru" />);

    const detailsButton = await screen.findByRole("button", { name: ru.audit.details });
    fireEvent.click(detailsButton);

    const dialog = await screen.findByRole("dialog", { name: ru.audit.eventDetails });
    await waitFor(() => expect(apiMocks.getAuditEvent).toHaveBeenCalledWith("test-token", event.id));
    expect(within(dialog).getByText(event.event_type)).toBeInTheDocument();
    expect(within(dialog).getByText(event.request_id!)).toBeInTheDocument();
    expect(within(dialog).getByText(event.details.payload as string)).toBeInTheDocument();
  });

  it("shows special permission controls only to superadmin and saves changed grants", async () => {
    const superadmin = userFactory({
      id: "00000000-0000-4000-8000-000000000100",
      username: "root",
      display_name: "Root",
      role: "superadmin",
      permissions: ["can_broadcast", "can_pin_messages"]
    });
    const target = userFactory({
      id: "00000000-0000-4000-8000-000000000101",
      username: "trusted",
      display_name: "Trusted Employee"
    });
    apiMocks.getCurrentUser.mockResolvedValue(superadmin);
    apiMocks.getAdminUsers.mockResolvedValue([target]);
    apiMocks.getAdminPermissions.mockResolvedValue([
      {
        key: "can_broadcast",
        category: "communications",
        description_ru: "RU broadcast",
        description_en: "Can broadcast",
        is_active: true,
        created_at: "2026-07-04T10:00:00Z",
        updated_at: "2026-07-04T10:00:00Z"
      },
      {
        key: "can_pin_messages",
        category: "messages",
        description_ru: "RU pin",
        description_en: "Can pin",
        is_active: true,
        created_at: "2026-07-04T10:00:00Z",
        updated_at: "2026-07-04T10:00:00Z"
      }
    ]);
    apiMocks.getAdminUserPermissions.mockResolvedValue({
      explicit_permissions: [],
      effective_permissions: [],
      inherited_from_superadmin: false
    });
    apiMocks.getAdminUsers.mockResolvedValueOnce([target]).mockResolvedValueOnce([{ ...target, display_name: "Trusted Employee" }]);

    render(<AdminUsers dictionary={en} locale="en" />);

    const targetRow = (await screen.findAllByText("Trusted Employee"))
      .map((element) => element.closest("tr"))
      .find((row): row is HTMLTableRowElement => row !== null);
    fireEvent.click(targetRow!);

    const dialog = await screen.findByRole("dialog", { name: en.adminUsers.editTitle });
    const pinCheckbox = await within(dialog).findByRole("checkbox", { name: /Pin messages/i });
    fireEvent.click(pinCheckbox);
    fireEvent.click(within(dialog).getByRole("button", { name: en.adminUsers.saveSubmit }));

    await waitFor(() =>
      expect(apiMocks.updateAdminUserPermissions).toHaveBeenCalledWith("test-token", target.id, ["can_pin_messages"])
    );
  });

  it("does not show special permission controls to normal admin", async () => {
    apiMocks.getAdminUsers.mockResolvedValue([userFactory({ display_name: "Employee" })]);

    render(<AdminUsers dictionary={en} locale="en" />);

    const targetRow = (await screen.findAllByText("Employee"))
      .map((element) => element.closest("tr"))
      .find((row): row is HTMLTableRowElement => row !== null);
    fireEvent.click(targetRow!);

    const dialog = await screen.findByRole("dialog", { name: en.adminUsers.editTitle });
    expect(within(dialog).queryByText(en.adminUsers.permissions.title)).not.toBeInTheDocument();
  });
});
