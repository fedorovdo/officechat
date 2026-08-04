import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPageHeader, AdminPageShell } from "../components/AdminUI";
import { Dashboard } from "../components/Dashboard";
import en from "../dictionaries/en.json";
import { userFactory } from "./factories";

const apiMocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  requireStoredAccessToken: vi.fn(() => "test-token")
}));
const sessionMocks = vi.hoisted(() => ({ logoutSession: vi.fn() }));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, ...apiMocks };
});

vi.mock("../lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/session")>();
  return { ...actual, ...sessionMocks };
});

describe("admin design system", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.requireStoredAccessToken.mockReturnValue("test-token");
    apiMocks.getCurrentUser.mockResolvedValue(userFactory({
      display_name: "OfficeChat Admin",
      role: "admin",
      username: "admin"
    }));
  });

  it("renders the shared page header with a left back link, icon, and one h1", () => {
    const { container } = render(
      <AdminPageShell ariaLabel="Users">
        <AdminPageHeader
          backHref="/en/dashboard"
          backLabel={en.adminUi.backToDashboard}
          description={en.adminUi.pageDescriptions.users}
          title={en.adminUsers.title}
        />
      </AdminPageShell>
    );

    const header = container.querySelector(".admin-page-header") as HTMLElement;
    const backLink = within(header).getByRole("link", { name: en.adminUi.backToDashboard });
    expect(header.firstElementChild).toBe(backLink);
    expect(backLink).toHaveAttribute("href", "/en/dashboard");
    expect(backLink.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(within(header).getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("renders five administration cards with correct routes and separates About", async () => {
    const { container } = render(<Dashboard dictionary={en} locale="en" />);
    await screen.findByText("OfficeChat Admin");

    const grid = container.querySelector(".admin-action-grid") as HTMLElement;
    const cards = within(grid).getAllByRole("link");
    expect(cards).toHaveLength(5);
    expect(cards.map((link) => link.getAttribute("href"))).toEqual([
      "/en/groups",
      "/en/admin/users",
      "/en/admin/bots",
      "/en/admin/storage",
      "/en/admin/audit"
    ]);

    const additional = container.querySelector(".admin-additional-card") as HTMLElement;
    expect(within(additional).getByRole("link", { name: /About/i })).toHaveAttribute("href", "/en/about");
    expect(within(grid).queryByRole("link", { name: /About/i })).not.toBeInTheDocument();
  });

  it("preserves account identity, primary app action, and secondary logout", async () => {
    render(<Dashboard dictionary={en} locale="en" />);
    await screen.findByText("OfficeChat Admin");

    expect(screen.getByText("@admin")).toBeInTheDocument();
    expect(screen.getByText("admin", { selector: ".admin-badge" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.dashboard.openApp })).toHaveClass("admin-button-primary");
    const logout = screen.getByRole("button", { name: en.dashboard.logout });
    expect(logout).toHaveClass("admin-button-secondary");
    fireEvent.click(logout);
    await waitFor(() => expect(sessionMocks.logoutSession).toHaveBeenCalledWith("en"));
  });
});
