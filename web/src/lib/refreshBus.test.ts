import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAll, registerRefresh, unregisterRefresh } from "./refreshBus";

// registry 是模块级共享 Map，用固定 key 并在用例后注销，避免相互污染
const KEYS = ["test:a", "test:b"] as const;

afterEach(() => {
  for (const k of KEYS) unregisterRefresh(k);
});

describe("refreshBus（web 通过 shared 复用）", () => {
  it("refreshAll 触发所有已注册的刷新函数", async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    registerRefresh(KEYS[0], a);
    registerRefresh(KEYS[1], b);

    await refreshAll();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("同 key 重复注册覆盖旧函数", async () => {
    const old = vi.fn().mockResolvedValue(undefined);
    const fresh = vi.fn().mockResolvedValue(undefined);
    registerRefresh(KEYS[0], old);
    registerRefresh(KEYS[0], fresh);

    await refreshAll();

    expect(old).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("注销后不再被 refreshAll 触发", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    registerRefresh(KEYS[0], fn);
    unregisterRefresh(KEYS[0]);

    await refreshAll();

    expect(fn).not.toHaveBeenCalled();
  });
});
