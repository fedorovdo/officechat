import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AboutPage } from "../components/AboutPage";
import { BrandLogo } from "../components/Brand";
import { LoginForm } from "../components/LoginForm";
import en from "../dictionaries/en.json";
import ru from "../dictionaries/ru.json";
import { officeChatBrand } from "../lib/brand";

const apiMocks = vi.hoisted(() => ({
  getAnnouncementUnread: vi.fn(),
  requireStoredAccessToken: vi.fn(() => "test-token")
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() })
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, ...apiMocks };
});

describe("OfficeChat branding and About", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.requireStoredAccessToken.mockReturnValue("test-token");
  });

  it("BrandLogo renders product name and compact mode keeps an accessible mark", () => {
    const { rerender } = render(<BrandLogo tagline="Corporate messenger" />);
    expect(screen.getAllByText(officeChatBrand.productName).length).toBeGreaterThan(0);
    expect(screen.getByText("Corporate messenger")).toBeInTheDocument();

    rerender(<BrandLogo compact />);
    expect(screen.getByRole("img", { name: officeChatBrand.productName })).toBeInTheDocument();
    expect(screen.queryByText("Corporate messenger")).not.toBeInTheDocument();
  });

  it("login page renders branding, version and About link", () => {
    render(<LoginForm dictionary={en} locale="en" />);

    expect(screen.getAllByText(officeChatBrand.productName).length).toBeGreaterThan(0);
    expect(screen.getByText("Corporate messenger")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(officeChatBrand.version))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.dashboard.about })).toHaveAttribute("href", "/en/about");
  });

  it("About EN page renders health status, centralized version and safe external links", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/health") {
        return Promise.resolve(
          new Response(JSON.stringify({ status: "ok", service: "officechat-frontend", version: officeChatBrand.version }))
        );
      }
      if (url.endsWith("/health")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "ok",
              service: "officechat-backend",
              product: "OfficeChat",
              version: officeChatBrand.version
            })
          )
        );
      }
      return Promise.reject(new Error("unexpected fetch"));
    });

    render(<AboutPage dictionary={en} locale="en" />);

    expect(screen.getByRole("heading", { name: en.about.title })).toBeInTheDocument();
    expect(screen.getByText(officeChatBrand.version)).toBeInTheDocument();
    expect(await screen.findAllByText(en.about.statusWorking)).toHaveLength(2);
    expect(screen.getByRole("link", { name: en.about.repository })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("About RU page shows a safe unavailable status", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    render(<AboutPage dictionary={ru} locale="ru" />);

    expect(screen.getByRole("heading", { name: ru.about.title })).toBeInTheDocument();
    expect(await screen.findByText(ru.about.statusUnavailableMessage)).toBeInTheDocument();
  });

});
