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

if (typeof window !== "undefined") {
  Object.defineProperty(window, "ResizeObserver", {
    writable: true,
    configurable: true,
    value: ResizeObserverMock,
  });

  // Radix 的浮层组件（Select / DropdownMenu / Popover / Tooltip）在打开时会调用这几个
  // jsdom 未实现的 DOM API。不打这几个补丁，任何针对它们的 RTL 测试都会在
  // "点击展开" 那一步抛 TypeError，而不是给出真实的断言失败。
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}


if (!globalThis.crypto?.subtle) {
  const subtle = {
    digest: async (_algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer, data instanceof ArrayBuffer ? 0 : data.byteOffset, data instanceof ArrayBuffer ? data.byteLength : data.byteLength);
      const digest = new Uint8Array(32);
      bytes.forEach((value, index) => { digest[index % digest.length] ^= value; });
      return digest.buffer;
    },
  } as SubtleCrypto;
  Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: subtle });
}
