import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SidebarAccountFooter } from "../components/SidebarAccountFooter";
import { SidebarConversationRow } from "../components/SidebarConversationRow";
import en from "../dictionaries/en.json";
import ru from "../dictionaries/ru.json";
import { userFactory } from "./factories";

function renderConversationRow(unreadCount: number, mentionCount = 0) {
  return render(
    <SidebarConversationRow
      avatar={<span data-testid="conversation-avatar">A</span>}
      dictionary={en}
      isCollapsed={false}
      isMentioned={mentionCount > 0}
      isSelected={false}
      isUnread={unreadCount > 0}
      mentionCount={mentionCount}
      name="Alarming messages"
      onClick={vi.fn()}
      preview="Disk space alert"
      secondary="alerts"
      timestamp="12:30"
      unreadCount={unreadCount}
    />
  );
}

describe("sidebar conversation rows", () => {
  it("keeps a group unread badge in the right meta column and outside the avatar", () => {
    const { container } = renderConversationRow(8);
    const row = screen.getByRole("button", { name: "Alarming messages, alerts" });
    const rightMeta = row.querySelector(".sidebar-item-right-meta");
    const avatar = row.querySelector(".sidebar-item-avatar");

    expect(rightMeta).not.toBeNull();
    expect(within(rightMeta as HTMLElement).getByText("8")).toBeInTheDocument();
    expect(within(avatar as HTMLElement).queryByText("8")).not.toBeInTheDocument();
    expect(container.querySelector(".sidebar-item-time")).toHaveTextContent("12:30");
  });

  it("uses the same right meta column for direct unread and mention badges", () => {
    renderConversationRow(3, 1);
    const rightMeta = screen.getByRole("button").querySelector(".sidebar-item-right-meta");
    expect(rightMeta).toContainElement(screen.getByLabelText("3 unread messages"));
    expect(rightMeta).toContainElement(screen.getByLabelText("1 mentions"));
  });

  it("renders 99+ above 99 and omits zero badges", () => {
    const { rerender } = renderConversationRow(120);
    expect(screen.getByText("99+")).toBeInTheDocument();

    rerender(
      <SidebarConversationRow
        avatar={<span>A</span>}
        dictionary={en}
        isCollapsed={false}
        isMentioned={false}
        isSelected={false}
        isUnread={false}
        mentionCount={0}
        name="General"
        onClick={vi.fn()}
        preview="No recent messages"
        secondary="general"
        unreadCount={0}
      />
    );
    expect(screen.queryByLabelText(/unread messages/)).not.toBeInTheDocument();
  });
});

describe("sidebar account footer", () => {
  const callbacks = {
    onLogout: vi.fn(),
    onOpenNotifications: vi.fn(),
    onOpenProfile: vi.fn(),
    onOpenSettings: vi.fn()
  };

  it("keeps superadmin identity visible and exposes admin actions through overflow", () => {
    const { container } = render(
      <SidebarAccountFooter
        currentUser={userFactory({
          display_name: "OfficeChat Superadmin",
          role: "superadmin",
          username: "admin"
        })}
        dictionary={en}
        locale="en"
        notificationUnreadCount={2}
        {...callbacks}
      />
    );

    expect(screen.getByText("OfficeChat Superadmin")).toBeInTheDocument();
    expect(screen.getByText("@admin")).toBeInTheDocument();
    const footer = container.querySelector(".messenger-sidebar-account");
    const identity = container.querySelector(".sidebar-account-button");
    const controls = container.querySelector(".sidebar-account-actions");
    const avatar = identity?.querySelector(".user-avatar");
    expect(footer?.children[0]).toBe(identity);
    expect(footer?.children[1]).toBe(controls);
    expect(identity).toContainElement(avatar as HTMLElement);
    expect(avatar).toHaveStyle({ "--avatar-size": "40px" });
    expect(
      within(controls as HTMLElement).getByRole("button", {
        name: "2 unread notifications"
      })
    ).toBeInTheDocument();
    expect(
      within(controls as HTMLElement).getByRole("button", { name: "Settings" })
    ).toBeInTheDocument();
    expect(
      within(controls as HTMLElement).getByRole("button", { name: "Logout" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Administrative actions" }));
    const menu = screen.getByRole("menu", { name: "Administrative actions" });
    expect(within(menu).getByText("User management")).toBeInTheDocument();
    expect(within(menu).getByText("Groups")).toBeInTheDocument();
    expect(within(menu).getByText("Audit log")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Administrative actions" })).toHaveFocus();
  });

  it("closes the admin overflow menu on an outside pointer action", () => {
    render(
      <div>
        <SidebarAccountFooter
          currentUser={userFactory({ role: "superadmin" })}
          dictionary={en}
          locale="en"
          notificationUnreadCount={0}
          {...callbacks}
        />
        <button type="button">Outside</button>
      </div>
    );

    fireEvent.click(screen.getByRole("button", { name: "Administrative actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not expose unauthorized admin actions to a regular user", () => {
    render(
      <SidebarAccountFooter
        currentUser={userFactory({ role: "user" })}
        dictionary={ru}
        locale="ru"
        notificationUnreadCount={0}
        {...callbacks}
      />
    );

    expect(screen.queryByRole("button", { name: "Административные действия" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: ru.appShell.settings })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ru.dashboard.logout })).toBeInTheDocument();
  });

  it.each([320, 360, 400])(
    "keeps stable two-row footer structure at %spx",
    (width) => {
      const { container } = render(
        <div style={{ width }}>
          <SidebarAccountFooter
            currentUser={userFactory({
              display_name: "A very long OfficeChat display name for layout testing",
              role: "superadmin"
            })}
            dictionary={en}
            locale="en"
            notificationUnreadCount={120}
            {...callbacks}
          />
        </div>
      );
      const footer = container.querySelector(".messenger-sidebar-account");
      expect(footer).toContainElement(
        container.querySelector(".sidebar-account-button")
      );
      expect(footer).toContainElement(
        container.querySelector(".sidebar-account-actions")
      );
      expect(container.querySelector(".notification-bell-badge")).toHaveTextContent("99+");
    }
  );
});
