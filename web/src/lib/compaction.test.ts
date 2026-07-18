import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiTranscriptBlock } from "@agent/shared";
import {
  asCompactionItem,
  compactionDoneReplacement,
  compactionItemFromBlock,
  createCompactionDoneItem,
  createCompactionRunningItem,
  type CompactionMessageItem,
  type CompactionOutcome,
} from "./compaction";

describe("asCompactionItem", () => {
  it("识别 type==='compaction' 的对象并原样返回", () => {
    const item = { id: "x", type: "compaction", status: "done" as const };
    // 返回的就是入参本身（非拷贝），便于就地识别
    expect(asCompactionItem(item)).toBe(item);
  });

  it("非 compaction / 非对象一律返回 null", () => {
    expect(asCompactionItem({ type: "user" })).toBeNull();
    expect(asCompactionItem(null)).toBeNull();
    expect(asCompactionItem(undefined)).toBeNull();
    expect(asCompactionItem("compaction")).toBeNull();
    expect(asCompactionItem(42)).toBeNull();
    expect(asCompactionItem({})).toBeNull();
  });
});

describe("createCompactionRunningItem", () => {
  it("生成 running 状态条，带 timestamp，无 summary/covered", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const item = createCompactionRunningItem() as unknown as CompactionMessageItem;
    expect(item.type).toBe("compaction");
    expect(item.status).toBe("running");
    expect(item.timestamp).toBe(1000);
    expect(item.summary).toBeUndefined();
    expect(item.coveredEventCount).toBeUndefined();
    vi.restoreAllMocks();
  });
});

describe("createCompactionDoneItem", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(2000);
  });

  it("无 outcome 时仅 done + timestamp，不带可选字段", () => {
    const item = createCompactionDoneItem() as unknown as CompactionMessageItem;
    expect(item.status).toBe("done");
    expect(item.timestamp).toBe(2000);
    expect("summary" in item).toBe(false);
    expect("coveredEventCount" in item).toBe(false);
    vi.restoreAllMocks();
  });

  it("有 summary 与 coveredEventCount 时透传", () => {
    const outcome: CompactionOutcome = { summary: "摘要", coveredEventCount: 12 };
    const item = createCompactionDoneItem(outcome) as unknown as CompactionMessageItem;
    expect(item.summary).toBe("摘要");
    expect(item.coveredEventCount).toBe(12);
    vi.restoreAllMocks();
  });

  it("summary 为空串（=== undefined 判定）仍保留空串字段", () => {
    const item = createCompactionDoneItem({ summary: "" }) as unknown as CompactionMessageItem;
    // 源码用 !== undefined 判定，空串会被保留
    expect("summary" in item).toBe(true);
    expect(item.summary).toBe("");
    vi.restoreAllMocks();
  });

  it("coveredEventCount 非 number（如 undefined）时不落字段", () => {
    const item = createCompactionDoneItem({ coveredEventCount: undefined }) as unknown as CompactionMessageItem;
    expect("coveredEventCount" in item).toBe(false);
    vi.restoreAllMocks();
  });
});

describe("compactionDoneReplacement", () => {
  it("保留传入 id 并填充 done 字段", () => {
    vi.spyOn(Date, "now").mockReturnValue(3000);
    const item = compactionDoneReplacement("keep-id", { summary: "s", coveredEventCount: 3 }) as unknown as CompactionMessageItem;
    expect(item.id).toBe("keep-id");
    expect(item.status).toBe("done");
    expect(item.summary).toBe("s");
    expect(item.coveredEventCount).toBe(3);
    expect(item.timestamp).toBe(3000);
    vi.restoreAllMocks();
  });
});

describe("compactionItemFromBlock", () => {
  it("从 transcript block 构造分界线：content→summary、coveredEventCount、tsMs→timestamp", () => {
    const block = {
      id: "block-1",
      kind: "compaction",
      content: "历史摘要正文",
      coveredEventCount: 8,
      tsMs: 4444,
    } as unknown as ApiTranscriptBlock;
    const item = compactionItemFromBlock(block) as unknown as CompactionMessageItem;
    expect(item).toMatchObject({
      id: "block-1",
      type: "compaction",
      status: "done",
      summary: "历史摘要正文",
      coveredEventCount: 8,
      timestamp: 4444,
    });
  });

  it("缺失 content/covered/tsMs 时仅保留 id + done", () => {
    const block = { id: "block-2", kind: "compaction" } as unknown as ApiTranscriptBlock;
    const item = compactionItemFromBlock(block) as unknown as CompactionMessageItem;
    expect(item.id).toBe("block-2");
    expect(item.status).toBe("done");
    expect("summary" in item).toBe(false);
    expect("coveredEventCount" in item).toBe(false);
    expect("timestamp" in item).toBe(false);
  });

  it("coveredEventCount 非 number 时忽略该字段", () => {
    const block = {
      id: "block-3",
      kind: "compaction",
      coveredEventCount: "10",
    } as unknown as ApiTranscriptBlock;
    const item = compactionItemFromBlock(block) as unknown as CompactionMessageItem;
    expect("coveredEventCount" in item).toBe(false);
  });
});
