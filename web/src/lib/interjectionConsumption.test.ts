import { describe, expect, it } from "vitest";
import {
  InterjectionConsumptionRegistry,
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
