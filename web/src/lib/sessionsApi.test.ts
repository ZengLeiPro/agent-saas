import { describe, expect, it } from "vitest";
import type { ApiSessionDetail, ApiTranscriptBlock } from "@agent/shared";
import { mapSessionDetailToMessages } from "./sessionsApi";

// 用真实 shared mapBlock 契约构造 detail：prompt→user、text→text，消息 id 与 block.id 同源。
// kind 用宽 string（源码对 'compaction' 等 shared union 外的 kind 走 `as string` 分支），
// 并允许 coveredEventCount 等 compaction 专属额外字段。
function block(partial: { id: string; kind: string; [key: string]: unknown }): ApiTranscriptBlock {
  return partial as unknown as ApiTranscriptBlock;
}

function detail(blocks: ApiTranscriptBlock[]): ApiSessionDetail {
  return { blocks } as unknown as ApiSessionDetail;
}

describe("mapSessionDetailToMessages（web 端 compaction 分界线插入）", () => {
  it("无 compaction block 时与 shared 基础映射一致", () => {
    const d = detail([
      block({ id: "b1", kind: "prompt", content: "你好", tsMs: 1 }),
      block({ id: "b2", kind: "text", content: "回复", tsMs: 2 }),
    ]);
    const result = mapSessionDetailToMessages(d);
    expect(result.map((m) => m.id)).toEqual(["b1", "b2"]);
    expect(result.every((m) => (m.type as string) !== "compaction")).toBe(true);
  });

  it("compaction block 插到其后第一个可渲染 block 之前", () => {
    const d = detail([
      block({ id: "b1", kind: "prompt", content: "问", tsMs: 1 }),
      block({ id: "c1", kind: "compaction", content: "摘要正文", coveredEventCount: 5, tsMs: 10 }),
      block({ id: "b2", kind: "text", content: "答", tsMs: 2 }),
    ]);
    const result = mapSessionDetailToMessages(d);
    // 顺序：b1、分界线、b2
    expect(result.map((m) => m.id)).toEqual(["b1", "c1", "b2"]);

    const marker = result[1] as unknown as { type: string; status: string; summary?: string; coveredEventCount?: number; timestamp?: number };
    expect(marker.type).toBe("compaction");
    expect(marker.status).toBe("done");
    expect(marker.summary).toBe("摘要正文");
    expect(marker.coveredEventCount).toBe(5);
    expect(marker.timestamp).toBe(10);
  });

  it("compaction 之后无可渲染 block 时追加到末尾", () => {
    const d = detail([
      block({ id: "b1", kind: "prompt", content: "问", tsMs: 1 }),
      block({ id: "c1", kind: "compaction", content: "尾部摘要", tsMs: 9 }),
      block({ id: "m1", kind: "meta", content: "" }), // meta 映射为 null，不可渲染
    ]);
    const result = mapSessionDetailToMessages(d);
    expect(result.map((m) => m.id)).toEqual(["b1", "c1"]);
    expect((result[1] as unknown as { type: string }).type).toBe("compaction");
  });

  it("多条 compaction 保持相对顺序，各自插到正确位置", () => {
    const d = detail([
      block({ id: "c1", kind: "compaction", content: "摘要1", tsMs: 1 }),
      block({ id: "b1", kind: "text", content: "A", tsMs: 2 }),
      block({ id: "c2", kind: "compaction", content: "摘要2", tsMs: 3 }),
      block({ id: "b2", kind: "text", content: "B", tsMs: 4 }),
    ]);
    const result = mapSessionDetailToMessages(d);
    expect(result.map((m) => m.id)).toEqual(["c1", "b1", "c2", "b2"]);
  });
});
