import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

afterEach(() => {
  cleanup();
});

Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  configurable: true,
  value: ResizeObserverMock,
});
