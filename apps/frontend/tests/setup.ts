import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class TestWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: TestWebSocket[] = [];

  readonly url: string;
  readyState = TestWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = vi.fn();

  constructor(url: string | URL) {
    this.url = String(url);
    TestWebSocket.instances.push(this);
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  close(code = 1000, reason = "") {
    this.readyState = TestWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }

  receive(data: object) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
});
Object.defineProperty(window, "ResizeObserver", { configurable: true, value: TestResizeObserver });
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
Object.defineProperty(window, "WebSocket", { configurable: true, writable: true, value: TestWebSocket });
Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: TestWebSocket });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  TestWebSocket.instances.length = 0;
  window.history.replaceState({}, "", "/ru/app");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: vi.fn(() => Promise.reject(new Error("Unexpected network request")))
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

export { TestWebSocket };
