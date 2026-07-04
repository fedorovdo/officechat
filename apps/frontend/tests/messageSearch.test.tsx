import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDictionary } from "../lib/i18n";
import { useMessageSearchShortcut } from "../lib/useMessageSearchShortcut";
import { searchResultFactory, userFactory } from "./factories";

const mocks = vi.hoisted(() => ({
  searchMessages: vi.fn(),
  getStoredAccessToken: vi.fn(() => "token")
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    searchMessages: mocks.searchMessages,
    getStoredAccessToken: mocks.getStoredAccessToken
  };
});

import { MessageSearchPanel } from "../components/MessageSearchPanel";

const ru = getDictionary("ru");
const en = getDictionary("en");
const directoryUsers = [userFactory()];

function renderPanel(overrides: Partial<ComponentProps<typeof MessageSearchPanel>> = {}) {
  const onClose = vi.fn();
  const onJump = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <MessageSearchPanel
      currentChat={{ chatType: "group", chatId: "group-1", title: "IT Department" }}
      dictionary={ru}
      locale="ru"
      onClose={onClose}
      onJump={onJump}
      users={directoryUsers}
      {...overrides}
    />
  );
  return { ...view, onClose, onJump };
}

async function advanceSearch() {
  await act(async () => {
    vi.advanceTimersByTime(350);
    await Promise.resolve();
  });
}

describe("message search UI", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.searchMessages.mockResolvedValue({ items: [], next_cursor: null, total_estimate: null });
  });

  it("renders named RU and EN dialogs", () => {
    const { rerender } = renderPanel();
    expect(screen.getByRole("dialog", { name: ru.messageSearch.title })).toBeInTheDocument();
    rerender(
      <MessageSearchPanel currentChat={null} dictionary={en} locale="en" onClose={vi.fn()} onJump={vi.fn()} users={[]} />
    );
    expect(screen.getByRole("dialog", { name: en.messageSearch.title })).toBeInTheDocument();
  });

  it("Escape closes the panel", async () => {
    const { onClose } = renderPanel();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("returns focus to the trigger after closing", () => {
    function SearchHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">Open search</button>
          {open ? (
            <MessageSearchPanel
              currentChat={null}
              dictionary={en}
              locale="en"
              onClose={() => setOpen(false)}
              onJump={vi.fn()}
              users={[]}
            />
          ) : null}
        </>
      );
    }

    render(<SearchHarness />);
    const trigger = screen.getByRole("button", { name: "Open search" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(trigger).toHaveFocus();
  });

  it("debounces input instead of searching every keystroke", async () => {
    renderPanel();
    fireEvent.change(screen.getByRole("searchbox", { name: ru.messageSearch.inputLabel }), { target: { value: "alert" } });
    vi.advanceTimersByTime(349);
    expect(mocks.searchMessages).not.toHaveBeenCalled();
    await advanceSearch();
    expect(mocks.searchMessages).toHaveBeenCalledOnce();
  });

  it("aborts an obsolete request", async () => {
    let firstSignal: AbortSignal | undefined;
    mocks.searchMessages.mockImplementationOnce((_token, _filters, signal) => {
      firstSignal = signal;
      return new Promise(() => undefined);
    });
    renderPanel();
    const input = screen.getByRole("searchbox", { name: ru.messageSearch.inputLabel });
    fireEvent.change(input, { target: { value: "first" } });
    await advanceSearch();
    fireEvent.change(input, { target: { value: "second" } });
    expect(firstSignal?.aborted).toBe(true);
  });

  it("forms a global search request", async () => {
    renderPanel();
    fireEvent.change(screen.getByRole("searchbox", { name: ru.messageSearch.inputLabel }), { target: { value: "server" } });
    await advanceSearch();
    expect(mocks.searchMessages).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({ q: "server", chat_type: undefined, chat_id: undefined }),
      expect.any(AbortSignal)
    );
  });

  it("adds chat_type and chat_id for current-chat search", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: ru.messageSearch.currentChat }));
    fireEvent.change(screen.getByRole("searchbox", { name: ru.messageSearch.inputLabel }), { target: { value: "server" } });
    await advanceSearch();
    expect(mocks.searchMessages).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({ chat_type: "group", chat_id: "group-1" }),
      expect.any(AbortSignal)
    );
  });

  it("announces loading and renders an empty state", async () => {
    let resolveSearch!: (value: { items: never[]; next_cursor: null; total_estimate: null }) => void;
    mocks.searchMessages.mockReturnValue(new Promise((resolve) => { resolveSearch = resolve; }));
    renderPanel();
    fireEvent.change(screen.getByRole("searchbox", { name: ru.messageSearch.inputLabel }), { target: { value: "missing" } });
    await advanceSearch();
    expect(screen.getByText(ru.messageSearch.loading, { selector: "[aria-live='polite']" })).toBeInTheDocument();
    await act(async () => {
      resolveSearch({ items: [], next_cursor: null, total_estimate: null });
      await Promise.resolve();
    });
    expect(screen.getByText(ru.messageSearch.empty)).toBeInTheDocument();
  });

  it("renders and highlights untrusted result text without unsafe HTML", async () => {
    mocks.searchMessages.mockResolvedValue({
      items: [searchResultFactory({ excerpt: "<img src=x onerror=alert(1)> server alert" })],
      next_cursor: null,
      total_estimate: null
    });
    const { container } = renderPanel();
    fireEvent.change(screen.getByRole("searchbox", { name: ru.messageSearch.inputLabel }), { target: { value: "alert" } });
    await advanceSearch();
    expect(screen.getAllByText("alert", { selector: "mark" })).toHaveLength(2);
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(container.querySelector(".message-search-excerpt")).toHaveTextContent("<img src=x onerror=alert(1)> server alert");
  });

  it("clicking a keyboard-accessible result invokes jump behavior", async () => {
    const result = searchResultFactory();
    mocks.searchMessages.mockResolvedValue({ items: [result], next_cursor: null, total_estimate: null });
    const { onJump } = renderPanel();
    fireEvent.change(screen.getByRole("searchbox", { name: ru.messageSearch.inputLabel }), { target: { value: "alert" } });
    await advanceSearch();
    const option = screen.getByRole("option", { name: new RegExp(ru.messageSearch.jump) });
    expect(option).toHaveAttribute("aria-selected", "true");
    fireEvent.click(option);
    expect(onJump).toHaveBeenCalledWith(result);
  });

  it("does not persist the raw query in localStorage", async () => {
    renderPanel();
    fireEvent.change(screen.getByRole("searchbox", { name: ru.messageSearch.inputLabel }), { target: { value: "private phrase" } });
    await advanceSearch();
    expect(JSON.stringify({ ...localStorage })).not.toContain("private phrase");
  });
});

describe("message search shortcut", () => {
  it("opens on Ctrl+K and Cmd+K but not Ctrl+F", () => {
    const onOpen = vi.fn();
    renderHook(() => useMessageSearchShortcut(onOpen));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(window, { key: "K", metaKey: true });
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
