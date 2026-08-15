import { describe, expect, it } from "vitest";
import {
  InterjectionConsumptionRegistry,
  reconcileQueuedInterjections,
  removeConsumedInterjections,
} from "./interjectionConsumption";

describe("InterjectionConsumptionRegistry", () => {
  it("已消费插话不会被旧 queued 广播或 detail 快照复活", () => {
    const registry = new InterjectionConsumptionRegistry();
    registry.markMany(["client-1"], ["source-1"]);

    expect(registry.has({ clientMsgId: "client-1", sourceRunId: "source-1" })).toBe(true);
    expect(registry.has({ clientMsgId: "client-1" })).toBe(true);
    expect(registry.has({ sourceRunId: "source-1" })).toBe(true);
    expect(registry.has({ clientMsgId: "client-2", sourceRunId: "source-2" })).toBe(false);
  });

  it("切换会话后清空消费标记", () => {
    const registry = new InterjectionConsumptionRegistry();
    registry.mark({ clientMsgId: "client-1", sourceRunId: "source-1" });

    registry.clear();

    expect(registry.has({ clientMsgId: "client-1", sourceRunId: "source-1" })).toBe(false);
  });
});

describe("reconcileQueuedInterjections", () => {
  it("刷新后从服务端快照恢复普通 queue 的模式、位置和 run 关联", () => {
    const registry = new InterjectionConsumptionRegistry();
    const next = reconcileQueuedInterjections([], [{
      sourceRunId: "queued-run-1",
      runId: "queued-run-1",
      clientMsgId: "client-1",
      deliveryMode: "queue",
      targetRunId: "active-run",
      queuePosition: 2,
      content: "刷新后仍存在",
      acceptedAt: "2026-08-14T02:00:00.000Z",
    }], registry);

    expect(next).toEqual([expect.objectContaining({
      clientMsgId: "client-1",
      sourceRunId: "queued-run-1",
      deliveryMode: "queue",
      targetRunId: "active-run",
      queuePosition: 2,
      status: "queued",
    })]);
  });

  it("硬刷新后从权威附件 DTO 重建可编辑和重发的 UploadedFile", () => {
    const next = reconcileQueuedInterjections([], [{
      sourceRunId: "queued-run-attachment",
      clientMsgId: "client-attachment",
      content: "带附件",
      acceptedAt: "2026-08-15T01:00:00.000Z",
      attachments: [{
        attachmentId: "att-1",
        name: "合同.pdf",
        savedPath: "/workspace/uploads/att-1/合同.pdf",
        relativePath: "uploads/att-1/合同.pdf",
        size: 2048,
        mimeType: "application/pdf",
        isImage: false,
      }],
    }], new InterjectionConsumptionRegistry(), "session-1");

    expect(next[0]).toMatchObject({
      sessionId: "session-1",
      uploadedFiles: [{
        attachmentId: "att-1",
        originalName: "合同.pdf",
        savedPath: "/workspace/uploads/att-1/合同.pdf",
        relativePath: "uploads/att-1/合同.pdf",
        size: 2048,
        mimeType: "application/pdf",
        isImage: false,
      }],
    });
  });
});

describe("removeConsumedInterjections", () => {
  const entries = [
    { clientMsgId: "client-1", sourceRunId: "source-1", content: "已消费" },
    { clientMsgId: "client-2", sourceRunId: "source-2", content: "仍排队" },
  ];

  it("按 clientMsgId 或 sourceRunId 移除已消费条目", () => {
    const next = removeConsumedInterjections(
      entries,
      new Set(["client-1"]),
      new Set<string>(),
    );

    expect(next).toEqual([entries[1]]);
  });

  it("重复消费事件无命中时保留数组引用", () => {
    const next = removeConsumedInterjections(
      entries,
      new Set(["missing-client"]),
      new Set(["missing-source"]),
    );

    expect(next).toBe(entries);
  });
});
