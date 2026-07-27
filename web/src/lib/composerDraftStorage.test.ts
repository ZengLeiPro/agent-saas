import { beforeEach, describe, expect, it } from "vitest";
import { INPUT_DRAFT_KEY } from "@/lib/constants";
import {
  getComposerDraftScope,
  loadComposerAttachments,
  loadComposerText,
  saveComposerAttachments,
  saveComposerText,
} from "./composerDraftStorage";

describe("composerDraftStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("按用户和会话生成互不冲突的草稿 scope", () => {
    expect(getComposerDraftScope("user-1", "session-1")).toBe("user-1.session-1");
    expect(getComposerDraftScope("user-1", null)).toBe("user-1.new");
    expect(getComposerDraftScope("user-2", "session-1"))
      .not.toBe(getComposerDraftScope("user-1", "session-1"));
  });

  it("不同会话的文字草稿独立保存和清空", () => {
    const first = getComposerDraftScope("user-1", "session-1");
    const second = getComposerDraftScope("user-1", "session-2");

    saveComposerText(first, "第一份草稿");
    saveComposerText(second, "第二份草稿");

    expect(loadComposerText(first)).toBe("第一份草稿");
    expect(loadComposerText(second)).toBe("第二份草稿");

    saveComposerText(first, "");
    expect(loadComposerText(first)).toBe("");
    expect(loadComposerText(second)).toBe("第二份草稿");
  });

  it("首次迁移旧的全局文字草稿", () => {
    const scope = getComposerDraftScope("user-1", null);
    localStorage.setItem(INPUT_DRAFT_KEY, "旧草稿");

    expect(loadComposerText(scope, true)).toBe("旧草稿");
    expect(localStorage.getItem(INPUT_DRAFT_KEY)).toBeNull();
    expect(loadComposerText(scope)).toBe("旧草稿");
  });

  it("IndexedDB 不可用时附件读写静默降级", async () => {
    await expect(loadComposerAttachments("user-1.session-1")).resolves.toEqual([]);
    await expect(saveComposerAttachments("user-1.session-1", [])).resolves.toBeUndefined();
  });
});
