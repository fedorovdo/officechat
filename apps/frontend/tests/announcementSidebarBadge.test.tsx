import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AnnouncementUnreadBadge,
  formatAnnouncementUnreadLabel
} from "../components/AnnouncementUnreadBadge";

function renderAnnouncementRow(count: number, locale: "ru" | "en", collapsed = false) {
  return render(
    <aside className={collapsed ? "user-app-sidebar-collapsed" : undefined}>
      <button
        aria-label={locale === "ru" ? "Объявления" : "Announcements"}
        className="user-app-nav-item user-app-nav-item-announcements"
        type="button"
      >
        <span className="chat-avatar chat-avatar-group" aria-hidden="true">!</span>
        <span className="sidebar-item-content">
          <span className="sidebar-item-top">
            <strong>{locale === "ru" ? "Объявления" : "Announcements"}</strong>
          </span>
          <span className="sidebar-item-preview">System announcements</span>
        </span>
        <AnnouncementUnreadBadge count={count} locale={locale} />
      </button>
    </aside>
  );
}

describe("announcement sidebar unread badge", () => {
  it("renders inside the Announcements row", () => {
    renderAnnouncementRow(3, "en");

    const row = screen.getByRole("button", { name: "Announcements" });
    const badge = within(row).getByLabelText("3 unread announcements");

    expect(row).toHaveClass("user-app-nav-item-announcements");
    expect(badge).toHaveClass("announcement-unread-badge");
    expect(badge).toHaveTextContent("3");
  });

  it("is hidden when unread count is zero", () => {
    renderAnnouncementRow(0, "en");

    const row = screen.getByRole("button", { name: "Announcements" });
    expect(within(row).queryByLabelText(/unread announcement/)).not.toBeInTheDocument();
  });

  it("shows 99+ above 99 while preserving the exact accessible count", () => {
    renderAnnouncementRow(120, "en");

    const row = screen.getByRole("button", { name: "Announcements" });
    const badge = within(row).getByLabelText("120 unread announcements");

    expect(badge).toHaveTextContent("99+");
  });

  it("uses RU accessible labels", () => {
    expect(formatAnnouncementUnreadLabel(1, "ru")).toBe("1 непрочитанное объявление");
    expect(formatAnnouncementUnreadLabel(3, "ru")).toBe("3 непрочитанных объявления");
    expect(formatAnnouncementUnreadLabel(5, "ru")).toBe("5 непрочитанных объявлений");
  });

  it("uses EN accessible labels", () => {
    expect(formatAnnouncementUnreadLabel(1, "en")).toBe("1 unread announcement");
    expect(formatAnnouncementUnreadLabel(3, "en")).toBe("3 unread announcements");
  });

  it("keeps the badge associated with the announcement icon in collapsed sidebar markup", () => {
    const { container } = renderAnnouncementRow(7, "ru", true);

    const row = screen.getByRole("button", { name: "Объявления" });
    const badge = within(row).getByLabelText("7 непрочитанных объявлений");

    expect(container.querySelector(".user-app-sidebar-collapsed")).toBeInTheDocument();
    expect(badge).toHaveClass("announcement-unread-badge");
  });
});
