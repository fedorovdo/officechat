import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminUsers } from "../components/AdminUsers";
import en from "../dictionaries/en.json";
import { userFactory } from "./factories";

const apiMocks = vi.hoisted(() => ({
  getAdminPermissions: vi.fn(),
  getAdminUserPermissions: vi.fn(),
  getAdminUsers: vi.fn(),
  getCurrentUser: vi.fn(),
  getStoredAccessToken: vi.fn(() => "test-token"),
  requireStoredAccessToken: vi.fn(() => "test-token"),
  resetAdminUserPassword: vi.fn(),
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

const actor = userFactory({
  id: "00000000-0000-4000-8000-000000000100",
  username: "root",
  display_name: "Root Administrator",
  role: "superadmin"
});

const target = userFactory({
  id: "00000000-0000-4000-8000-000000000101",
  username: "target",
  display_name: "Target User",
  role: "superadmin",
  auth_provider: "local"
});

async function openTargetEditor() {
  render(<AdminUsers dictionary={en} locale="en" />);
  const row = (await screen.findAllByText(target.display_name))
    .map((element) => element.closest("tr"))
    .find((candidate): candidate is HTMLTableRowElement => candidate !== null);
  expect(row).toBeDefined();
  fireEvent.click(row!);
  return screen.findByRole("dialog", { name: en.adminUsers.editTitle });
}

describe("admin user password reset", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getCurrentUser.mockResolvedValue(actor);
    apiMocks.getAdminUsers.mockResolvedValue([target]);
    apiMocks.getAdminPermissions.mockResolvedValue([]);
    apiMocks.getAdminUserPermissions.mockResolvedValue({
      explicit_permissions: [],
      effective_permissions: [],
      inherited_from_superadmin: false
    });
    apiMocks.updateAdminUser.mockImplementation((_token: string, _userId: string, payload: object) =>
      Promise.resolve(userFactory({ ...target, ...payload }))
    );
    apiMocks.resetAdminUserPassword.mockResolvedValue(target);
  });

  it("saves profile fields without calling password reset", async () => {
    const dialog = await openTargetEditor();
    fireEvent.change(within(dialog).getByLabelText(en.adminUsers.fields.displayName), {
      target: { value: "Updated Target" }
    });
    fireEvent.change(within(dialog).getByLabelText(en.adminUsers.fields.newPassword), {
      target: { value: "password-not-for-profile-save" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: en.adminUsers.saveSubmit }));

    await waitFor(() =>
      expect(apiMocks.updateAdminUser).toHaveBeenCalledWith(
        "test-token",
        target.id,
        {
          display_name: "Updated Target",
          email: target.email,
          role: target.role,
          is_active: target.is_active
        }
      )
    );
    expect(apiMocks.resetAdminUserPassword).not.toHaveBeenCalled();
  });

  it("resets only the password, shows dedicated success, and clears the field", async () => {
    const password = "temporary-password-123";
    let resolveReset!: (user: typeof target) => void;
    apiMocks.resetAdminUserPassword.mockReturnValue(new Promise((resolve) => {
      resolveReset = resolve;
    }));
    const dialog = await openTargetEditor();
    const input = within(dialog).getByLabelText(en.adminUsers.fields.newPassword);
    fireEvent.change(input, { target: { value: password } });
    fireEvent.click(within(dialog).getByRole("button", { name: en.adminUsers.resetSubmit }));

    await waitFor(() =>
      expect(apiMocks.resetAdminUserPassword).toHaveBeenCalledWith("test-token", target.id, password)
    );
    expect(apiMocks.updateAdminUser).not.toHaveBeenCalled();
    expect(within(dialog).queryByText(en.adminUsers.resetSuccess)).not.toBeInTheDocument();

    resolveReset(target);

    expect(await within(dialog).findByText(en.adminUsers.resetSuccess)).toBeInTheDocument();
    expect(within(dialog).queryByText(en.adminUsers.updateSuccess)).not.toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(dialog.textContent).not.toContain(password);
  });

  it("sends the exact reset request from the rendered password form", async () => {
    const password = "dom-password-reset-123";
    const actualApi = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(target), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    apiMocks.resetAdminUserPassword.mockImplementation(actualApi.resetAdminUserPassword);

    const dialog = await openTargetEditor();
    fireEvent.change(within(dialog).getByLabelText(en.adminUsers.fields.newPassword), {
      target: { value: password }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: en.adminUsers.resetSubmit }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/admin/users/${target.id}/reset-password`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ new_password: password });
    expect(apiMocks.updateAdminUser).not.toHaveBeenCalled();
    expect(await within(dialog).findByText(en.adminUsers.resetSuccess)).toBeInTheDocument();
  });

  it("clears stale profile success when the password operation starts", async () => {
    const dialog = await openTargetEditor();
    fireEvent.click(within(dialog).getByRole("button", { name: en.adminUsers.saveSubmit }));
    expect(await within(dialog).findByText(en.adminUsers.updateSuccess)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(en.adminUsers.fields.newPassword), {
      target: { value: "new-password-operation" }
    });

    expect(within(dialog).queryByText(en.adminUsers.updateSuccess)).not.toBeInTheDocument();
  });

  it.each([400, 403, 422, 500])("shows a safe reset error for HTTP %s", async (status) => {
    const password = `rejected-password-${status}`;
    apiMocks.resetAdminUserPassword.mockRejectedValue(new Error(`HTTP ${status}: upstream detail`));
    const dialog = await openTargetEditor();
    const input = within(dialog).getByLabelText(en.adminUsers.fields.newPassword);
    fireEvent.change(input, { target: { value: password } });
    fireEvent.click(within(dialog).getByRole("button", { name: en.adminUsers.resetSubmit }));

    expect(await within(dialog).findByText(en.adminUsers.resetError)).toBeInTheDocument();
    expect(within(dialog).queryByText(en.adminUsers.resetSuccess)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(en.adminUsers.updateSuccess)).not.toBeInTheDocument();
    expect(input).toHaveValue(password);
    expect(dialog.textContent).not.toContain(password);
    expect(dialog.textContent).not.toContain("upstream detail");
  });

  it("does not submit a password shorter than eight characters", async () => {
    const dialog = await openTargetEditor();
    fireEvent.click(within(dialog).getByRole("button", { name: en.adminUsers.saveSubmit }));
    expect(await within(dialog).findByText(en.adminUsers.updateSuccess)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(en.adminUsers.fields.newPassword), {
      target: { value: "short" }
    });

    expect(within(dialog).queryByText(en.adminUsers.updateSuccess)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(en.adminUsers.resetSuccess)).not.toBeInTheDocument();
    const resetButton = within(dialog).getByRole("button", { name: en.adminUsers.resetSubmit });
    expect(resetButton).toBeDisabled();
    fireEvent.click(resetButton);
    expect(apiMocks.resetAdminUserPassword).not.toHaveBeenCalled();
  });

  it("allows a superadmin actor to reset another local superadmin", async () => {
    const dialog = await openTargetEditor();
    expect(within(dialog).getByLabelText(en.adminUsers.fields.newPassword)).toHaveAttribute("type", "password");
    expect(within(dialog).getByRole("button", { name: en.adminUsers.resetSubmit })).toBeInTheDocument();
  });

  it("does not expose local password reset controls for an external user", async () => {
    apiMocks.getAdminUsers.mockResolvedValue([{ ...target, auth_provider: "ldap" }]);
    render(<AdminUsers dictionary={en} locale="en" />);
    const row = (await screen.findAllByText(target.display_name))
      .map((element) => element.closest("tr"))
      .find((candidate): candidate is HTMLTableRowElement => candidate !== null);
    fireEvent.click(row!);

    const dialog = await screen.findByRole("dialog", { name: en.adminUsers.editTitle });
    expect(within(dialog).queryByLabelText(en.adminUsers.fields.newPassword)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: en.adminUsers.resetSubmit })).not.toBeInTheDocument();
  });
});
