import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DirectoryPanel } from "../components/DirectoryPanel";
import { getDictionary } from "../lib/i18n";
import type { OfficeChatDirectoryEntry } from "../lib/api";
import { userFactory } from "./factories";

const apiMocks = vi.hoisted(() => ({
  archiveDirectoryEntry: vi.fn(),
  createDirectoryEntry: vi.fn(),
  getDirectoryDepartments: vi.fn(),
  getDirectoryEntries: vi.fn(),
  getStoredAccessToken: vi.fn(() => "token"),
  restoreDirectoryEntry: vi.fn(),
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
  manager = false,
  dictionary = en,
  onStartDirect = vi.fn()
}: {
  manager?: boolean;
  dictionary?: typeof en;
  onStartDirect?: (userId: string) => void;
} = {}) {
  return render(
    <DirectoryPanel
      currentUser={userFactory({
        id: "user-1",
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
    apiMocks.updateDirectoryEntry.mockResolvedValue(entry);
    apiMocks.archiveDirectoryEntry.mockResolvedValue({ ...entry, is_active: false });
    apiMocks.restoreDirectoryEntry.mockResolvedValue(entry);
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
    expect(screen.getByLabelText(en.directory.activity)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: en.directory.edit }).length).toBeGreaterThan(0);
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
    expect(ru.directory.title).toBe("Справочник");
    expect(en.adminUsers.permissions.items.can_manage_directory.label).toBeTruthy();
    expect(ru.adminUsers.permissions.items.can_manage_directory.label).toBeTruthy();
  });
});
