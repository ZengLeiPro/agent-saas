import { beforeEach, describe, expect, it } from "vitest";
import type { MessageItem } from "@/components/types";
import {
  clearAllMessageCache,
  clearSessionMessages,
  loadSessionMessages,
  saveSessionMessages,
} from "./messageCache";

/**
 * 说明：jsdom 环境不提供 indexedDB（typeof indexedDB === 'undefined'），
 * 且本仓库未引入 fake-indexeddb，测试文件也不允许改 setup/依赖。
 * 因此本套件覆盖的是「IndexedDB 不可用时的优雅降级」契约——这是 messageCache
 * 对外承诺的核心健壮性行为：所有 try/catch 分支都不得把底层错误抛给调用方。
 * IndexedDB 可用时的命中/TTL/裁剪等逻辑需依赖 fake-indexeddb，暂跳过（见返回说明）。
 */
describe("messageCache 在 IndexedDB 不可用时的优雅降级", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loadSessionMessages 吞异常返回 null", async () => {
    await expect(loadSessionMessages("session-1")).resolves.toBeNull();
  });

  it("saveSessionMessages fire-and-forget 不抛错", () => {
    const messages = [
      { id: "m1", type: "user", status: "pending" } as unknown as MessageItem,
    ];
    expect(() => saveSessionMessages("session-1", messages)).not.toThrow();
  });

  it("clearSessionMessages 静默完成", async () => {
    await expect(clearSessionMessages("session-1")).resolves.toBeUndefined();
  });

  it("clearAllMessageCache 静默完成", async () => {
    await expect(clearAllMessageCache()).resolves.toBeUndefined();
  });

  it("save 后 load 因无持久层仍返回 null（不因缺失后端而崩溃）", async () => {
    saveSessionMessages("session-2", []);
    await expect(loadSessionMessages("session-2")).resolves.toBeNull();
  });
});
