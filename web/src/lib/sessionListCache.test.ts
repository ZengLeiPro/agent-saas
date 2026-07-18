import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiSessionListItem } from "@/lib/sessionsApi";
import {
  clearSessionListCache,
  loadSessionListCache,
  saveSessionListCache,
} from "./sessionListCache";

const CACHE_KEY = "sessionList:default";

function makeSession(id: string): ApiSessionListItem {
  return { id, title: `会话 ${id}` } as unknown as ApiSessionListItem;
}

describe("sessionListCache", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("保存后可读回相同的 sessions 与 hasMore", () => {
    const sessions = [makeSession("a"), makeSession("b")];
    saveSessionListCache(sessions, true);

    const loaded = loadSessionListCache();
    expect(loaded).toEqual({ sessions, hasMore: true });
  });

  it("未写入缓存时读取返回 null", () => {
    expect(loadSessionListCache()).toBeNull();
  });

  it("空 sessions 列表视为无有效缓存，返回 null", () => {
    saveSessionListCache([], false);
    expect(loadSessionListCache()).toBeNull();
  });

  it("clear 后读取返回 null", () => {
    saveSessionListCache([makeSession("a")], false);
    expect(loadSessionListCache()).not.toBeNull();
    clearSessionListCache();
    expect(loadSessionListCache()).toBeNull();
  });

  it("缓存内容损坏（非法 JSON）时读取吞异常返回 null", () => {
    localStorage.setItem(CACHE_KEY, "{not-json");
    expect(loadSessionListCache()).toBeNull();
  });

  it("写入抛错（如 quota exceeded）被静默吞掉，不抛给调用方", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveSessionListCache([makeSession("a")], false)).not.toThrow();
  });

  it("hasMore 默认透传 false", () => {
    saveSessionListCache([makeSession("x")], false);
    expect(loadSessionListCache()?.hasMore).toBe(false);
  });
});
