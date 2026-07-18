import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearLegacyApiCaches,
  isUpdateReady,
  maybeNavigateWithUpdate,
  maybeReloadOnPopstate,
  registerBeforeReloadHook,
  registerUpdateGuard,
  subscribeUpdateReady,
} from "./swUpdate";

/**
 * 说明：swUpdate 有大量模块级状态（updateReady/applying/hasInteracted）与真正的
 * 整页跳转副作用（window.location.assign/reload）。为不污染其它测试且避免误触发跳转，
 * 本套件只覆盖「初始状态（updateReady=false）」下确定、无副作用的分支：
 * 注册/注销 API 的可逆性、以及未就绪时导航拦截入口一律短路返回 false（不跳转）。
 * 冷启动静默刷、controllerchange 接管等依赖真实 SW/时序的路径不可靠，跳过。
 */
describe("swUpdate 注册/注销 API", () => {
  it("registerUpdateGuard 返回可用的注销函数", () => {
    const guard = vi.fn(() => false);
    const off = registerUpdateGuard(guard);
    expect(typeof off).toBe("function");
    expect(off()).toBe(true); // Set.delete 命中返回 true
    // 二次注销已不存在，返回 false
    expect(off()).toBe(false);
  });

  it("registerBeforeReloadHook 返回可用的注销函数", () => {
    const hook = vi.fn();
    const off = registerBeforeReloadHook(hook);
    expect(off()).toBe(true);
    expect(off()).toBe(false);
    expect(hook).not.toHaveBeenCalled();
  });

  it("subscribeUpdateReady 返回可用的注销函数", () => {
    const listener = vi.fn();
    const off = subscribeUpdateReady(listener);
    expect(off()).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("未就绪时导航拦截入口短路（不跳转）", () => {
  it("初始 isUpdateReady 为 false", () => {
    expect(isUpdateReady()).toBe(false);
  });

  it("maybeNavigateWithUpdate 在未就绪时返回 false（返回 false 即代表未接管跳转）", () => {
    // updateReady=false 时源码在触碰 window.location 之前就 return false，无跳转副作用
    expect(maybeNavigateWithUpdate("/next")).toBe(false);
  });

  it("maybeReloadOnPopstate 在未就绪时返回 false，不触发 reload", () => {
    expect(maybeReloadOnPopstate()).toBe(false);
  });
});

describe("clearLegacyApiCaches", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("环境无 caches 时安全返回（不抛错）", async () => {
    // jsdom 默认无 caches；确保未 stub 时直接短路
    if ("caches" in globalThis) {
      // 某些环境可能存在，显式移除以覆盖 early-return 分支
      vi.stubGlobal("caches", undefined);
    }
    await expect(clearLegacyApiCaches()).resolves.toBeUndefined();
  });

  it("只删除 api- 前缀缓存，保留其它", async () => {
    const del = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", {
      keys: vi.fn().mockResolvedValue(["api-a", "api-b", "workbox-precache-v1"]),
      delete: del,
    });
    await clearLegacyApiCaches();
    expect(del.mock.calls.map(([n]) => n)).toEqual(["api-a", "api-b"]);
  });
});
