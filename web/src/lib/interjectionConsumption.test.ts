import { describe, expect, it } from "vitest";
import {
  InterjectionConsumptionRegistry,
  projectAuthoritativeInterjections,
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

  it("硬刷新后从 path-free 权威附件 DTO 以同一 attachmentId 重建重发状态", () => {
    const next = reconcileQueuedInterjections([], [{
      sourceRunId: "queued-run-attachment",
      targetRunId: "active-run",
      clientMsgId: "client-attachment",
      content: "带附件",
      acceptedAt: "2026-08-15T01:00:00.000Z",
      attachments: [{
        attachmentId: "11111111-1111-4111-8111-111111111111",
        name: "合同.pdf",
        size: 2048,
        mimeType: "application/pdf",
        isImage: false,
      }],
    }], new InterjectionConsumptionRegistry(), "session-1");

    expect(next[0]).toMatchObject({
      sessionId: "session-1",
      uploadedFiles: [{
        attachmentId: "11111111-1111-4111-8111-111111111111",
        originalName: "合同.pdf",
        relativePath: "",
        size: 2048,
        mimeType: "application/pdf",
        isImage: false,
      }],
    });
  });

  it("普通 standalone pending run 不进入插话队列栏", () => {
    const next = reconcileQueuedInterjections([{
      clientMsgId: "client-standalone",
      deliveryMode: "steer",
      content: "普通新消息",
      status: "sending",
      createdAt: 1,
    }], [{
      sourceRunId: "standalone-run",
      runId: "standalone-run",
      clientMsgId: "client-standalone",
      deliveryMode: "steer",
      content: "普通新消息",
      acceptedAt: "2026-09-03T07:59:35.000Z",
    }], new InterjectionConsumptionRegistry(), "session-1");

    expect(next).toEqual([]);
  });
});

describe("projectAuthoritativeInterjections", () => {
  const queueItem = {
    sessionId: "session-1",
    clientMsgId: "client-1",
    runId: "source-run",
    sourceRunId: "source-run",
    deliveryMode: "steer" as const,
    status: "queued" as const,
    content: "补充消息",
    acceptedAt: "2026-09-03T07:59:35.000Z",
  };

  it("普通 standalone pending run 不进入插话队列栏", () => {
    const local = {
      clientMsgId: "client-1",
      deliveryMode: "steer" as const,
      content: "补充消息",
      status: "sending" as const,
      createdAt: 1,
    };
    expect(projectAuthoritativeInterjections(
      [queueItem], [local], new InterjectionConsumptionRegistry(),
    )).toEqual([]);
  });

  it("只有等待目标 run 的消息进入队列栏，且消费后旧快照不能复活", () => {
    const registry = new InterjectionConsumptionRegistry();
    const interjection = { ...queueItem, targetRunId: "target-run" };

    expect(projectAuthoritativeInterjections([interjection], [], registry)).toEqual([
      expect.objectContaining({ clientMsgId: "client-1", targetRunId: "target-run", status: "queued" }),
    ]);
    registry.mark({ clientMsgId: "client-1", sourceRunId: "source-run" });
    expect(projectAuthoritativeInterjections([interjection], [], registry)).toEqual([]);
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
