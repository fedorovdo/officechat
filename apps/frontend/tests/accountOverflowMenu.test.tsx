import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { StrictMode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import { SidebarAccountFooter } from "../components/SidebarAccountFooter";
import en from "../dictionaries/en.json";
import ru from "../dictionaries/ru.json";
import type { OfficeChatUser } from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { userFactory } from "./factories";

type TestRect = Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">;

function rect(left: number, top: number, width: number, height: number): TestRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width
  };
}

let buttonRect = rect(80, 600, 34, 34);
let menuRect = rect(0, 0, 240, 210);

const callbacks = {
  onLogout: vi.fn(),
  onOpenNotifications: vi.fn(),
  onOpenProfile: vi.fn(),
  onOpenSettings: vi.fn()
};

function renderFooter({
  dictionary = en,
  locale = "en",
  role = "superadmin",
  sidebarClass = "",
  width = 320
}: {
  dictionary?: Dictionary;
  locale?: Locale;
  role?: OfficeChatUser["role"];
  sidebarClass?: string;
  width?: number;
} = {}) {
  return render(
    <aside
      className={`user-app-sidebar ${sidebarClass}`.trim()}
      style={{ width }}
    >
      <div className="user-app-nav-list" data-testid="sidebar-scroll" />
      <SidebarAccountFooter
        currentUser={userFactory({ role })}
        dictionary={dictionary}
        locale={locale}
        notificationUnreadCount={2}
        {...callbacks}
      />
    </aside>
  );
}

function openMenu() {
  fireEvent.click(
    screen.getByRole("button", { name: en.appShell.adminMenu })
  );
  return screen.getByRole("menu", { name: en.appShell.adminMenu });
}

describe("sidebar account overflow menu", () => {
  beforeEach(() => {
    buttonRect = rect(80, 600, 34, 34);
    menuRect = rect(0, 0, 240, 210);
    Object.defineProperties(window, {
      innerHeight: { configurable: true, value: 768, writable: true },
      innerWidth: { configurable: true, value: 1024, writable: true }
    });
    vi.spyOn(
      HTMLElement.prototype,
      "getBoundingClientRect"
    ).mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("sidebar-admin-menu")) {
        return menuRect as DOMRect;
      }
      if (this.getAttribute("aria-haspopup") === "menu") {
        return buttonRect as DOMRect;
      }
      return rect(0, 0, 0, 0) as DOMRect;
    });
    vi.spyOn(
      HTMLElement.prototype,
      "scrollHeight",
      "get"
    ).mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("sidebar-admin-menu")
        ? menuRect.height
        : 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders through document.body and outside the sidebar scroll tree", () => {
    const { container } = renderFooter();
    const button = screen.getByRole("button", {
      name: en.appShell.adminMenu
    });
    const menu = openMenu();

    expect(document.body).toContainElement(menu);
    expect(container).not.toContainElement(menu);
    expect(menu.closest(".user-app-sidebar")).toBeNull();
    expect(menu.closest(".user-app-nav-list")).toBeNull();
    expect(button).toHaveAttribute("aria-controls", menu.id);
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it.each([
    { label: "left sidebar", left: 2, viewport: 1024, expectedLeft: 10 },
    { label: "right sidebar", left: 990, viewport: 1024, expectedLeft: 774 },
    { label: "narrow viewport", left: 150, viewport: 180, expectedLeft: 10 }
  ])(
    "keeps the menu inside the viewport for $label",
    async ({ left, viewport, expectedLeft }) => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: viewport,
        writable: true
      });
      buttonRect = rect(left, 600, 34, 34);
      const menu = openMenuAfterRender();

      await waitFor(() =>
        expect(menu).toHaveStyle({ left: `${expectedLeft}px` })
      );
      const renderedLeft = Number.parseFloat(menu.style.left);
      const renderedWidth = Number.parseFloat(menu.style.width);
      expect(renderedLeft).toBeGreaterThanOrEqual(10);
      expect(renderedLeft + renderedWidth).toBeLessThanOrEqual(viewport - 10);
    }
  );

  it("opens above when space is sufficient and below near the top edge", async () => {
    renderFooter();
    let menu = openMenu();
    await waitFor(() => expect(menu).toHaveAttribute("data-placement", "above"));
    expect(menu).toHaveStyle({ top: "382px" });

    fireEvent.click(
      screen.getByRole("button", { name: en.appShell.adminMenu })
    );
    buttonRect = rect(80, 20, 34, 34);
    menu = openMenu();
    await waitFor(() => expect(menu).toHaveAttribute("data-placement", "below"));
    expect(menu).toHaveStyle({ top: "62px" });
  });

  it("constrains an oversized menu and scrolls within viewport bounds", async () => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 240,
      writable: true
    });
    buttonRect = rect(80, 110, 34, 34);
    menuRect = rect(0, 0, 240, 500);
    renderFooter();
    const menu = openMenu();

    await waitFor(() => expect(menu.style.maxHeight).not.toBe(""));
    const top = Number.parseFloat(menu.style.top);
    const maxHeight = Number.parseFloat(menu.style.maxHeight);
    expect(top).toBeGreaterThanOrEqual(10);
    expect(top + maxHeight).toBeLessThanOrEqual(230);
  });

  it("recalculates on resize and closes on scroll", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
      writable: true
    });
    buttonRect = rect(1100, 600, 34, 34);
    renderFooter({ sidebarClass: "user-app-shell-sidebar-right", width: 400 });
    const menu = openMenu();
    await waitFor(() => expect(menu).toHaveStyle({ left: "894px" }));

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 400,
      writable: true
    });
    buttonRect = rect(360, 600, 34, 34);
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(menu).toHaveStyle({ left: "150px" }));

    fireEvent.scroll(screen.getByTestId("sidebar-scroll"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("recalculates when the sidebar geometry changes", async () => {
    let resizeCallback!: ResizeObserverCallback;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }

        observe = observe;
        disconnect = disconnect;
      }
    );
    const { container, unmount } = renderFooter({
      sidebarClass: "user-app-shell-sidebar-right",
      width: 400
    });
    buttonRect = rect(900, 600, 34, 34);
    const menu = openMenu();
    await waitFor(() => expect(menu).toHaveStyle({ left: "694px" }));
    expect(observe).toHaveBeenCalledWith(
      screen.getByRole("button", { name: en.appShell.adminMenu })
    );
    expect(observe).toHaveBeenCalledWith(
      container.querySelector(".user-app-sidebar")
    );

    buttonRect = rect(700, 600, 34, 34);
    act(() => resizeCallback([], {} as ResizeObserver));
    await waitFor(() => expect(menu).toHaveStyle({ left: "494px" }));
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("supports keyboard opening, navigation, Escape focus return and Tab close", () => {
    renderFooter();
    const button = screen.getByRole("button", {
      name: en.appShell.adminMenu
    });
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: en.appShell.adminMenu });
    const items = within(menu).getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: "End" });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(items[items.length - 1], { key: "Home" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveFocus();

    fireEvent.keyDown(button, { key: " " });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on outside click and menu item selection", () => {
    renderFooter();
    let menu = openMenu();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    menu = openMenu();
    fireEvent.click(within(menu).getByText(en.adminUsers.title));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps RU and EN accessible labels and role permissions", () => {
    const { unmount } = renderFooter({ dictionary: ru, locale: "ru" });
    expect(
      screen.getByRole("button", { name: ru.appShell.adminMenu })
    ).toHaveAttribute("aria-haspopup", "menu");
    unmount();

    renderFooter({ role: "user" });
    expect(
      screen.queryByRole("button", { name: en.appShell.adminMenu })
    ).not.toBeInTheDocument();
  });

  it.each([320, 360, 400])(
    "preserves the two-row footer at %spx",
    (width) => {
      const { container } = renderFooter({ width });
      const footer = container.querySelector(".messenger-sidebar-account");
      expect(footer?.children).toHaveLength(2);
      expect(footer?.children[0]).toHaveClass("sidebar-account-button");
      expect(footer?.children[1]).toHaveClass("sidebar-account-actions");
    }
  );

  it("cleans all global listeners under React Strict Mode", () => {
    const documentAdd = vi.spyOn(document, "addEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    const windowAdd = vi.spyOn(window, "addEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(
      <StrictMode>
        <SidebarAccountFooter
          currentUser={userFactory({ role: "superadmin" })}
          dictionary={en}
          locale="en"
          notificationUnreadCount={0}
          {...callbacks}
        />
      </StrictMode>
    );

    openMenu();
    unmount();

    for (const type of ["pointerdown", "keydown"]) {
      expect(
        documentAdd.mock.calls.filter(([eventType]) => eventType === type)
      ).toHaveLength(
        documentRemove.mock.calls.filter(([eventType]) => eventType === type)
          .length
      );
    }
    for (const type of ["resize", "scroll"]) {
      expect(
        windowAdd.mock.calls.filter(([eventType]) => eventType === type)
      ).toHaveLength(
        windowRemove.mock.calls.filter(([eventType]) => eventType === type)
          .length
      );
    }
  });
});

function openMenuAfterRender() {
  renderFooter();
  return openMenu();
}
