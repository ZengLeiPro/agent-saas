import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearUnreadAiReplyCache,
  getUnreadAiRepliesStorageKey,
  loadUnreadAiReplySessionIds,
  saveUnreadAiReplySessionIds,
} from "./unreadAiReplies";

const PREFIX = "agentChat.unreadAiReplies.v1";

describe("getUnreadAiRepliesStorageKey", () => {
  it("按 userId 拼 key", () => {
    expect(getUnreadAiRepliesStorageKey("u1")).toBe(`${PREFIX}:u1`);
  });

  it("未登录用户回退到 no-auth", () => {
    expect(getUnreadAiRepliesStorageKey(undefined)).toBe(`${PREFIX}:no-auth`);
  });
});

describe("save / load 未读会话集合", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("往返写读得到相同集合", () => {
    const key = getUnreadAiRepliesStorageKey("u1");
    saveUnreadAiReplySessionIds(key, new Set(["s1", "s2"]));
    expect(loadUnreadAiReplySessionIds(key)).toEqual(new Set(["s1", "s2"]));
  });

  it("无对应存储返回空集合", () => {
    expect(loadUnreadAiReplySessionIds("missing")).toEqual(new Set());
  });

  it("非法 JSON 时返回空集合", () => {
    const key = getUnreadAiRepliesStorageKey("u1");
    localStorage.setItem(key, "{broken");
    expect(loadUnreadAiReplySessionIds(key)).toEqual(new Set());
  });

  it("存储非数组时返回空集合", () => {
    const key = getUnreadAiRepliesStorageKey("u1");
    localStorage.setItem(key, JSON.stringify({ not: "array" }));
    expect(loadUnreadAiReplySessionIds(key)).toEqual(new Set());
  });

  it("数组内混杂非字符串项被过滤", () => {
    const key = getUnreadAiRepliesStorageKey("u1");
    localStorage.setItem(key, JSON.stringify(["ok", 123, null, "ok2"]));
    expect(loadUnreadAiReplySessionIds(key)).toEqual(new Set(["ok", "ok2"]));
  });

  it("保存空集合写入空数组", () => {
    const key = getUnreadAiRepliesStorageKey("u1");
    saveUnreadAiReplySessionIds(key, new Set());
    expect(localStorage.getItem(key)).toBe("[]");
  });

  it("保存抛错（quota）被静默吞掉", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveUnreadAiReplySessionIds("k", new Set(["a"]))).not.toThrow();
  });
});

describe("clearUnreadAiReplyCache", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("只清理本前缀的所有用户 key，保留无关 key", () => {
    saveUnreadAiReplySessionIds(getUnreadAiRepliesStorageKey("u1"), new Set(["a"]));
    saveUnreadAiReplySessionIds(getUnreadAiRepliesStorageKey("u2"), new Set(["b"]));
    localStorage.setItem("unrelated.key", "keep");

    clearUnreadAiReplyCache();

    expect(loadUnreadAiReplySessionIds(getUnreadAiRepliesStorageKey("u1")).size).toBe(0);
    expect(loadUnreadAiReplySessionIds(getUnreadAiRepliesStorageKey("u2")).size).toBe(0);
    expect(localStorage.getItem("unrelated.key")).toBe("keep");
  });
});
