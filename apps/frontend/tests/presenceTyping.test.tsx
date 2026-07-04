import { act, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PresenceStatus } from "../components/PresenceStatus";
import { TypingIndicator } from "../components/TypingIndicator";
import { getDictionary } from "../lib/i18n";
import { useTyping } from "../lib/useTyping";

const ru = getDictionary("ru");
const en = getDictionary("en");

describe("presence status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T12:00:00Z"));
  });

  it("renders an accessible online indicator", () => {
    render(<PresenceStatus dictionary={ru} locale="ru" presence={{ user_id: "u1", status: "online", last_seen_at: null }} />);
    expect(screen.getByLabelText(ru.presence.online)).toHaveTextContent(ru.presence.online);
  });

  it("renders localized offline last-seen text", () => {
    render(<PresenceStatus dictionary={en} locale="en" presence={{ user_id: "u1", status: "offline", last_seen_at: "2026-07-04T11:55:00Z" }} />);
    expect(screen.getByLabelText(en.presence.minutesAgo.replace("{count}", "5"))).toBeInTheDocument();
  });

  it("updates visible status after a presence event rerender", () => {
    const { rerender } = render(<PresenceStatus dictionary={en} locale="en" presence={{ user_id: "u1", status: "offline", last_seen_at: null }} />);
    expect(screen.getByLabelText(en.presence.offline)).toBeInTheDocument();
    rerender(<PresenceStatus dictionary={en} locale="en" presence={{ user_id: "u1", status: "online", last_seen_at: null }} />);
    expect(screen.getByLabelText(en.presence.online)).toBeInTheDocument();
  });
});

describe("typing indicators", () => {
  function socketRef() {
    const cleanup = Object.assign(vi.fn(), { send: vi.fn(() => true) });
    return { current: cleanup };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T12:00:00Z"));
  });

  it("renders one and multiple typing users", () => {
    const { rerender } = render(<TypingIndicator dictionary={en} users={[{ userId: "1", displayName: "Alice" }]} />);
    expect(screen.getByText(en.typing.one.replace("{name}", "Alice"))).toBeInTheDocument();
    rerender(<TypingIndicator dictionary={en} users={[{ userId: "1", displayName: "Alice" }, { userId: "2", displayName: "Bob" }]} />);
    expect(screen.getByText(en.typing.two.replace("{first}", "Alice").replace("{second}", "Bob"))).toBeInTheDocument();
  });

  it("adds incoming typing and expires it", () => {
    const socket = socketRef();
    const { result } = renderHook(() => useTyping(socket, "self", "group-1"));
    act(() => result.current.handleTypingEvent({ type: "typing.updated", user_id: "other", display_name: "Alice", is_typing: true }));
    expect(result.current.typingUsers).toEqual([{ userId: "other", displayName: "Alice" }]);
    act(() => vi.advanceTimersByTime(7000));
    expect(result.current.typingUsers).toEqual([]);
  });

  it("throttles typing.start", () => {
    const socket = socketRef();
    const { result } = renderHook(() => useTyping(socket, "self", "group-1"));
    act(() => {
      result.current.notifyTyping("a");
      result.current.notifyTyping("ab");
    });
    expect(socket.current.send).toHaveBeenCalledTimes(1);
    expect(socket.current.send).toHaveBeenCalledWith({ type: "typing.start" });
  });

  it("sends typing.stop on submission", () => {
    const socket = socketRef();
    const { result } = renderHook(() => useTyping(socket, "self", "group-1"));
    act(() => result.current.notifyTyping("message"));
    act(() => result.current.stopTyping());
    expect(socket.current.send).toHaveBeenLastCalledWith({ type: "typing.stop" });
  });

  it("sends typing.stop and clears users when chat changes", () => {
    const socket = socketRef();
    const { result, rerender } = renderHook(
      ({ contextKey }) => useTyping(socket, "self", contextKey),
      { initialProps: { contextKey: "group-1" } }
    );
    act(() => {
      result.current.notifyTyping("message");
      result.current.handleTypingEvent({ type: "typing.updated", user_id: "other", display_name: "Alice", is_typing: true });
    });
    rerender({ contextKey: "group-2" });
    expect(socket.current.send).toHaveBeenLastCalledWith({ type: "typing.stop" });
    expect(result.current.typingUsers).toEqual([]);
  });
});
