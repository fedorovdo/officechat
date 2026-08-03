import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DirectoryPanel } from "../components/DirectoryPanel";
import { getDictionary } from "../lib/i18n";
import { ApiResponseError, type OfficeChatDirectoryEntry, type UserRole } from "../lib/api";
import { userFactory } from "./factories";

const apiMocks = vi.hoisted(() => ({
  archiveDirectoryEntry: vi.fn(),
  createDirectoryEntry: vi.fn(),
  deleteDirectoryEntryPermanently: vi.fn(),
  getDirectoryDepartments: vi.fn(),
  getDirectoryEntries: vi.fn(),
  getStoredAccessToken: vi.fn(() => "token"),
  restoreDirectoryEntry: vi.fn(),
  getDirectoryImports: vi.fn(),
  updateDirectoryEntry: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, ...apiMocks };
});

const en = getDictionary("en");
const ru = getDictionary("ru");
const linkedUser = {
  id: "user-2",
  username: "dmitrii",
  display_name: "Dmitrii Fedorov",
  role: "user" as const,
  is_active: true,
  avatar_url: null,
  last_seen_at: null
};
const entry: OfficeChatDirectoryEntry = {
  id: "entry-1",
  display_name: "Dmitrii Fedorov",
  department: "IT",
  position: "Engineer",
  internal_phone: "1234",
  work_phone: "+7 (495) 123-45-67",
  mobile_phone: null,
  email: "dmitrii@example.test",
  room: "501",
  location: "Main office",
  notes: "On-call engineer",
  linked_user_id: linkedUser.id,
  linked_user: linkedUser,
  is_active: true,
  created_at: "2026-07-25T10:00:00Z",
  updated_at: "2026-07-25T10:00:00Z",
  created_by_user_id: "user-1",
  updated_by_user_id: "user-1"
};

function renderPanel({
  currentUserId = "user-1",
  manager = false,
  role = "user",
  dictionary = en,
  onStartDirect = vi.fn()
}: {
  currentUserId?: string;
  manager?: boolean;
  role?: UserRole;
  dictionary?: typeof en;
  onStartDirect?: (userId: string) => void;
} = {}) {
  return render(
    <DirectoryPanel
      currentUser={userFactory({
        id: currentUserId,
        role,
        permissions: manager ? ["can_manage_directory"] : []
      })}
      dictionary={dictionary}
      locale={dictionary === ru ? "ru" : "en"}
      onBack={vi.fn()}
      onStartDirect={onStartDirect}
      users={[linkedUser]}
    />
  );
}

describe("directory panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getDirectoryEntries.mockResolvedValue({
      items: [entry],
      total: 1,
      page: 1,
      limit: 30
    });
    apiMocks.getDirectoryDepartments.mockResolvedValue({ items: ["IT", "Operations"] });
    apiMocks.createDirectoryEntry.mockResolvedValue(entry);
    apiMocks.deleteDirectoryEntryPermanently.mockResolvedValue(undefined);
    apiMocks.updateDirectoryEntry.mockResolvedValue(entry);
    apiMocks.archiveDirectoryEntry.mockResolvedValue({ ...entry, is_active: false });
    apiMocks.restoreDirectoryEntry.mockResolvedValue(entry);
    apiMocks.getDirectoryImports.mockResolvedValue({ items: [], total: 0, page: 1, limit: 10 });
  });

  it("loads and renders contact details with tel and mailto links", async () => {
    const onStartDirect = vi.fn();
    renderPanel({ onStartDirect });

    expect(await screen.findAllByText("Dmitrii Fedorov")).not.toHaveLength(0);
    expect(screen.getAllByRole("link", { name: "1234" })[0]).toHaveAttribute("href", "tel:1234");
    expect(screen.getAllByRole("link", { name: "+7 (495) 123-45-67" })[0]).toHaveAttribute(
      "href",
      "tel:+74951234567"
    );
    expect(screen.getAllByRole("link", { name: "dmitrii@example.test" })[0]).toHaveAttribute(
      "href",
      "mailto:dmitrii@example.test"
    );
    expect(screen.queryByRole("button", { name: en.directory.add })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: en.directory.message })[0]);
    expect(onStartDirect).toHaveBeenCalledWith("user-2");
  });

  it("shows the linked OfficeChat user in desktop, mobile and contact detail views", async () => {
    renderPanel();

    expect((await screen.findAllByText("OfficeChat: @dmitrii")).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getAllByRole("button", { name: en.directory.open })[0]);

    const dialog = screen.getByRole("dialog", { name: entry.display_name });
    expect(within(dialog).getByText("Dmitrii Fedorov (@dmitrii)")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: en.directory.messageInOfficeChat })
    ).toBeInTheDocument();
  });

  it("uses the users list when an older response has only linked_user_id", async () => {
    const onStartDirect = vi.fn();
    apiMocks.getDirectoryEntries.mockResolvedValueOnce({
      items: [{ ...entry, linked_user: null }],
      total: 1,
      page: 1,
      limit: 30
    });
    renderPanel({ onStartDirect });

    expect((await screen.findAllByText("OfficeChat: @dmitrii")).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getAllByRole("button", { name: en.directory.message })[0]);
    expect(onStartDirect).toHaveBeenCalledWith(linkedUser.id);
  });

  it("does not show messaging actions when there is no linked user", async () => {
    apiMocks.getDirectoryEntries.mockResolvedValueOnce({
      items: [{ ...entry, linked_user_id: null, linked_user: null }],
      total: 1,
      page: 1,
      limit: 30
    });
    renderPanel();

    await screen.findAllByText(entry.display_name);
    expect(screen.queryByText("OfficeChat: @dmitrii")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.directory.message })).not.toBeInTheDocument();
  });

  it("marks the current linked user and does not offer a self conversation", async () => {
    renderPanel({ currentUserId: linkedUser.id });

    expect(await screen.findAllByText(en.directory.thisIsYou)).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: en.directory.message })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: en.directory.open })[0]);
    expect(
      within(screen.getByRole("dialog", { name: entry.display_name })).queryByRole("button", {
        name: en.directory.messageInOfficeChat
      })
    ).not.toBeInTheDocument();
  });

  it("shows a disabled linked account without a messaging action", async () => {
    const disabledUser = { ...linkedUser, is_active: false };
    apiMocks.getDirectoryEntries.mockResolvedValueOnce({
      items: [{ ...entry, linked_user: disabledUser }],
      total: 1,
      page: 1,
      limit: 30
    });
    render(
      <DirectoryPanel
        currentUser={userFactory({ id: "user-1" })}
        dictionary={en}
        locale="en"
        onBack={vi.fn()}
        onStartDirect={vi.fn()}
        users={[disabledUser]}
      />
    );

    expect(await screen.findAllByText(en.directory.accountDisabled)).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: en.directory.message })).not.toBeInTheDocument();
  });

  it("does not offer a direct conversation for a linked bot user", async () => {
    const botUser = { ...linkedUser, username: "alerts_bot", role: "bot" as const };
    apiMocks.getDirectoryEntries.mockResolvedValueOnce({
      items: [{ ...entry, linked_user_id: botUser.id, linked_user: botUser }],
      total: 1,
      page: 1,
      limit: 30
    });
    render(
      <DirectoryPanel
        currentUser={userFactory({ id: "user-1" })}
        dictionary={en}
        locale="en"
        onBack={vi.fn()}
        onStartDirect={vi.fn()}
        users={[botUser]}
      />
    );

    expect(await screen.findAllByText("OfficeChat: @alerts_bot")).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: en.directory.message })).not.toBeInTheDocument();
  });

  it("applies search and department filters without losing pagination conventions", async () => {
    renderPanel();
    await screen.findAllByText("Dmitrii Fedorov");
    apiMocks.getDirectoryEntries.mockClear();

    fireEvent.change(screen.getByLabelText(en.directory.search), { target: { value: "123-45" } });
    fireEvent.click(screen.getByRole("button", { name: en.directory.apply }));
    await waitFor(() =>
      expect(apiMocks.getDirectoryEntries).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({ search: "123-45", page: 1, limit: 30 })
      )
    );

    fireEvent.change(screen.getByLabelText(en.directory.department), { target: { value: "IT" } });
    await waitFor(() =>
      expect(apiMocks.getDirectoryEntries).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({ department: "IT", search: "123-45" })
      )
    );
  });

  it("ignores stale search responses that finish out of order", async () => {
    renderPanel();
    await screen.findAllByText("Dmitrii Fedorov");
    apiMocks.getDirectoryEntries.mockClear();

    let resolveOld!: (value: unknown) => void;
    let resolveLatest!: (value: unknown) => void;
    apiMocks.getDirectoryEntries
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveLatest = resolve; }));

    fireEvent.change(screen.getByLabelText(en.directory.search), { target: { value: "old" } });
    fireEvent.click(screen.getByRole("button", { name: en.directory.apply }));
    await waitFor(() =>
      expect(apiMocks.getDirectoryEntries).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({ search: "old" })
      )
    );

    fireEvent.change(screen.getByLabelText(en.directory.search), { target: { value: "latest" } });
    fireEvent.click(screen.getByRole("button", { name: en.directory.apply }));
    await waitFor(() =>
      expect(apiMocks.getDirectoryEntries).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({ search: "latest" })
      )
    );

    resolveLatest({
      items: [{ ...entry, id: "entry-latest", display_name: "Latest result" }],
      total: 1,
      page: 1,
      limit: 30
    });
    expect(await screen.findAllByText("Latest result")).not.toHaveLength(0);

    resolveOld({
      items: [{ ...entry, id: "entry-old", display_name: "Old result" }],
      total: 1,
      page: 1,
      limit: 30
    });
    await waitFor(() => expect(screen.queryByText("Old result")).not.toBeInTheDocument());
    expect(screen.getAllByText("Latest result")).not.toHaveLength(0);
  });

  it("shows management controls only with can_manage_directory", async () => {
    const regular = renderPanel();
    await screen.findAllByText("Dmitrii Fedorov");
    expect(screen.queryByRole("button", { name: en.directory.add })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(en.directory.activity)).not.toBeInTheDocument();
    regular.unmount();

    renderPanel({ manager: true });
    expect(await screen.findByRole("button", { name: en.directory.add })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.directoryImport.open })).toBeInTheDocument();
    expect(screen.getByLabelText(en.directory.activity)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: en.directory.edit }).length).toBeGreaterThan(0);
  });

  it("uses active status by default and lets managers filter archived entries", async () => {
    renderPanel({ manager: true });
    await screen.findAllByText("Dmitrii Fedorov");
    expect(apiMocks.getDirectoryEntries).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({ status: "active" })
    );

    fireEvent.change(screen.getByLabelText(en.directory.activity), {
      target: { value: "archived" }
    });
    await waitFor(() =>
      expect(apiMocks.getDirectoryEntries).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({ status: "archived", page: 1 })
      )
    );
    expect(apiMocks.getDirectoryDepartments).toHaveBeenCalledWith("token", true);
  });

  it("shows permanent delete only to superadmin for archived unlinked entries", async () => {
    const archived = {
      ...entry,
      linked_user_id: null,
      linked_user: null,
      is_active: false
    };
    apiMocks.getDirectoryEntries.mockResolvedValue({
      items: [archived],
      total: 1,
      page: 1,
      limit: 30
    });

    const managerView = renderPanel({ manager: true, role: "admin" });
    await screen.findAllByText(archived.display_name);
    fireEvent.click(screen.getAllByRole("button", { name: en.directory.open })[0]);
    expect(
      screen.queryByRole("button", { name: en.directory.deletePermanently })
    ).not.toBeInTheDocument();
    managerView.unmount();

    renderPanel({ manager: true, role: "superadmin" });
    await screen.findAllByText(archived.display_name);
    fireEvent.click(screen.getAllByRole("button", { name: en.directory.open })[0]);
    expect(
      screen.getByRole("button", { name: en.directory.deletePermanently })
    ).toBeInTheDocument();
    expect(screen.getAllByText(en.directory.archived).length).toBeGreaterThanOrEqual(2);
  });

  it("never offers permanent delete for active or linked entries", async () => {
    renderPanel({ manager: true, role: "superadmin" });
    await screen.findAllByText(entry.display_name);
    fireEvent.click(screen.getAllByRole("button", { name: en.directory.open })[0]);
    expect(
      screen.queryByRole("button", { name: en.directory.deletePermanently })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.directory.close }));

    apiMocks.getDirectoryEntries.mockResolvedValue({
      items: [{ ...entry, is_active: false }],
      total: 1,
      page: 1,
      limit: 30
    });
    fireEvent.change(screen.getByLabelText(en.directory.activity), {
      target: { value: "archived" }
    });
    await waitFor(() => expect(screen.getAllByText(en.directory.archived).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: en.directory.open })[0]);
    expect(
      screen.queryByRole("button", { name: en.directory.deletePermanently })
    ).not.toBeInTheDocument();
  });

  it("requires a reason and exact name, blocks double submit, then refreshes", async () => {
    const archived = {
      ...entry,
      linked_user_id: null,
      linked_user: null,
      is_active: false
    };
    apiMocks.getDirectoryEntries.mockResolvedValue({
      items: [archived],
      total: 1,
      page: 1,
      limit: 30
    });
    let resolveDelete!: () => void;
    apiMocks.deleteDirectoryEntryPermanently.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      })
    );
    renderPanel({ manager: true, role: "superadmin" });
    await screen.findAllByText(archived.display_name);
    fireEvent.click(screen.getAllByRole("button", { name: en.directory.open })[0]);
    fireEvent.click(screen.getByRole("button", { name: en.directory.deletePermanently }));

    const dialog = screen.getByRole("dialog", { name: en.directory.deleteTitle });
    const submit = within(dialog).getByRole("button", { name: en.directory.deletePermanently });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(en.directory.deleteReason), {
      target: { value: "duplicate" }
    });
    fireEvent.change(
      within(dialog).getByLabelText(
        en.directory.deleteConfirmation.replace("{name}", archived.display_name)
      ),
      { target: { value: `  ${archived.display_name}  ` } }
    );
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(apiMocks.deleteDirectoryEntryPermanently).toHaveBeenCalledTimes(1);
    expect(apiMocks.deleteDirectoryEntryPermanently).toHaveBeenCalledWith(
      "token",
      archived.id,
      {
        confirmation_name: archived.display_name,
        reason: "duplicate",
        expected_updated_at: archived.updated_at
      }
    );
    resolveDelete();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: en.directory.deleteTitle })).not.toBeInTheDocument()
    );
    expect(await screen.findByText(en.directory.deleteSuccess)).toBeInTheDocument();
    expect(apiMocks.getDirectoryEntries.mock.calls.length).toBeGreaterThan(1);
    expect(apiMocks.getDirectoryDepartments.mock.calls.length).toBeGreaterThan(1);
  });

  it.each([
    ["directory_entry_stale", en.directory.deleteErrors.stale],
    ["directory_entry_linked_user", en.directory.deleteErrors.linkedUser],
    ["directory_entry_delete_restricted", en.directory.deleteErrors.restricted]
  ] as const)("shows localized permanent-delete error %s without raw backend text", async (code, message) => {
    const archived = {
      ...entry,
      linked_user_id: null,
      linked_user: null,
      is_active: false
    };
    apiMocks.getDirectoryEntries.mockResolvedValue({
      items: [archived],
      total: 1,
      page: 1,
      limit: 30
    });
    apiMocks.deleteDirectoryEntryPermanently.mockRejectedValueOnce(
      new ApiResponseError(409, code)
    );
    renderPanel({ manager: true, role: "superadmin" });
    await screen.findAllByText(archived.display_name);
    fireEvent.click(screen.getAllByRole("button", { name: en.directory.open })[0]);
    fireEvent.click(screen.getByRole("button", { name: en.directory.deletePermanently }));
    const dialog = screen.getByRole("dialog", { name: en.directory.deleteTitle });
    fireEvent.change(within(dialog).getByLabelText(en.directory.deleteReason), {
      target: { value: "test_data" }
    });
    fireEvent.change(
      within(dialog).getByLabelText(
        en.directory.deleteConfirmation.replace("{name}", archived.display_name)
      ),
      { target: { value: archived.display_name } }
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: en.directory.deletePermanently })
    );
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(code)).not.toBeInTheDocument();
  });

  it("closes the permanent-delete dialog with Escape before submission", async () => {
    const archived = {
      ...entry,
      linked_user_id: null,
      linked_user: null,
      is_active: false
    };
    apiMocks.getDirectoryEntries.mockResolvedValue({
      items: [archived],
      total: 1,
      page: 1,
      limit: 30
    });
    renderPanel({ manager: true, role: "superadmin" });
    await screen.findAllByText(archived.display_name);
    fireEvent.click(screen.getAllByRole("button", { name: en.directory.open })[0]);
    fireEvent.click(screen.getByRole("button", { name: en.directory.deletePermanently }));
    expect(screen.getByRole("dialog", { name: en.directory.deleteTitle })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: en.directory.deleteTitle })
    ).not.toBeInTheDocument();
    expect(apiMocks.deleteDirectoryEntryPermanently).not.toHaveBeenCalled();
  });

  it("creates and edits entries through localized forms", async () => {
    renderPanel({ manager: true });
    await screen.findAllByText("Dmitrii Fedorov");
    const initialDepartmentLoads = apiMocks.getDirectoryDepartments.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: en.directory.add }));
    const createDialog = screen.getByRole("dialog", { name: en.directory.createTitle });
    fireEvent.change(within(createDialog).getByLabelText(en.directory.fields.displayName), {
      target: { value: "Vladimir Lenin" }
    });
    fireEvent.change(within(createDialog).getByLabelText(en.directory.fields.department), {
      target: { value: "Operations" }
    });
    fireEvent.click(within(createDialog).getByRole("button", { name: en.directory.save }));
    await waitFor(() =>
      expect(apiMocks.createDirectoryEntry).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({
          display_name: "Vladimir Lenin",
          department: "Operations"
        })
      )
    );
    await waitFor(() =>
      expect(apiMocks.getDirectoryDepartments.mock.calls.length).toBeGreaterThan(
        initialDepartmentLoads
      )
    );
    const departmentLoadsAfterCreate = apiMocks.getDirectoryDepartments.mock.calls.length;

    fireEvent.click(screen.getAllByRole("button", { name: en.directory.edit })[0]);
    const editDialog = screen.getByRole("dialog", { name: en.directory.editTitle });
    fireEvent.change(within(editDialog).getByLabelText(en.directory.fields.position), {
      target: { value: "Senior Engineer" }
    });
    fireEvent.click(within(editDialog).getByRole("button", { name: en.directory.save }));
    await waitFor(() =>
      expect(apiMocks.updateDirectoryEntry).toHaveBeenCalledWith(
        "token",
        entry.id,
        expect.objectContaining({ position: "Senior Engineer" })
      )
    );
    await waitFor(() =>
      expect(apiMocks.getDirectoryDepartments.mock.calls.length).toBeGreaterThan(
        departmentLoadsAfterCreate
      )
    );
  });

  it("archives with confirmation, blocks duplicate actions and refreshes departments", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let resolveArchive!: (value: OfficeChatDirectoryEntry) => void;
    apiMocks.archiveDirectoryEntry.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveArchive = resolve;
      })
    );
    renderPanel({ manager: true });
    await screen.findAllByText("Dmitrii Fedorov");
    const initialDepartmentLoads = apiMocks.getDirectoryDepartments.mock.calls.length;

    fireEvent.click(screen.getAllByRole("button", { name: en.directory.open })[0]);
    const archiveButton = screen.getByRole("button", { name: en.directory.archive });
    fireEvent.click(archiveButton);
    expect(archiveButton).toBeDisabled();
    await waitFor(() => expect(apiMocks.archiveDirectoryEntry).toHaveBeenCalledWith("token", entry.id));
    expect(window.confirm).toHaveBeenCalledWith(en.directory.archiveConfirm);
    resolveArchive({ ...entry, is_active: false });
    await waitFor(() =>
      expect(apiMocks.getDirectoryDepartments.mock.calls.length).toBeGreaterThan(
        initialDepartmentLoads
      )
    );
  });

  it("renders loading, empty and error states", async () => {
    let resolveRequest!: (value: unknown) => void;
    apiMocks.getDirectoryEntries.mockReturnValueOnce(new Promise((resolve) => { resolveRequest = resolve; }));
    const loading = renderPanel();
    expect(screen.getByRole("status")).toHaveTextContent(en.directory.loading);
    resolveRequest({ items: [], total: 0, page: 1, limit: 30 });
    expect(await screen.findByText(en.directory.empty)).toBeInTheDocument();
    loading.unmount();

    apiMocks.getDirectoryEntries.mockRejectedValueOnce(new Error("backend detail"));
    renderPanel();
    expect(await screen.findByText(en.directory.loadError)).toBeInTheDocument();
    expect(screen.queryByText(en.directory.empty)).not.toBeInTheDocument();
    expect(screen.queryByText("backend detail")).not.toBeInTheDocument();
  });

  it("recovers when a mutation leaves the current page beyond the new total", async () => {
    apiMocks.getDirectoryEntries.mockReset();
    apiMocks.getDirectoryEntries
      .mockResolvedValueOnce({ items: [entry], total: 31, page: 1, limit: 30 })
      .mockResolvedValueOnce({ items: [], total: 30, page: 2, limit: 30 })
      .mockResolvedValue({ items: [entry], total: 30, page: 1, limit: 30 });

    renderPanel({ manager: true });
    await screen.findAllByText("Dmitrii Fedorov");
    fireEvent.click(screen.getByRole("button", { name: en.directory.next }));

    await waitFor(() =>
      expect(apiMocks.getDirectoryEntries).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({ page: 2, limit: 30 })
      )
    );
    await waitFor(() =>
      expect(apiMocks.getDirectoryEntries).toHaveBeenLastCalledWith(
        "token",
        expect.objectContaining({ page: 1, limit: 30 })
      )
    );
    expect(await screen.findAllByText("Dmitrii Fedorov")).not.toHaveLength(0);
  });

  it("provides equivalent RU and EN localization keys", () => {
    expect(en.directory.title).toBe("Directory");
    expect(en.directory.messageInOfficeChat).toBeTruthy();
    expect(ru.directory.messageInOfficeChat).toBeTruthy();
    expect(en.directory.thisIsYou).toBeTruthy();
    expect(ru.directory.thisIsYou).toBeTruthy();
    expect(en.directory.accountDisabled).toBeTruthy();
    expect(ru.directory.accountDisabled).toBeTruthy();
    expect(en.directory.archivedOnly).toBeTruthy();
    expect(ru.directory.archivedOnly).toBeTruthy();
    expect(en.directory.deleteReasons.privacy_request).toBeTruthy();
    expect(ru.directory.deleteReasons.privacy_request).toBeTruthy();
    expect(ru.directory.title).toBe("Справочник");
    expect(en.adminUsers.permissions.items.can_manage_directory.label).toBeTruthy();
    expect(ru.adminUsers.permissions.items.can_manage_directory.label).toBeTruthy();
  });
});
