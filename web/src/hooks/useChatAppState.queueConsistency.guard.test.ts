import { describe, expect, it, vi } from "vitest";

import type { QueuedInterjection } from "../lib/interjectionConsumption";
import {
  acquireMessageSubmissionSlot,
  finalizeNotFoundSubmission,
  markSteeringCancelledForStop,
  recoverQueueSnapshotAfterSyncOverflow,
  shouldAcceptSessionEvent,
} from "../lib/queueConsistency";

function queued(
  clientMsgId: string,
  deliveryMode: "queue" | "steer",
  status: QueuedInterjection["status"] = "queued",
): QueuedInterjection {
  return {
    clientMsgId,
    deliveryMode,
    content: clientMsgId,
    status,
    createdAt: 1,
  };
}

describe("会话消息队列一致性行为", () => {
  it("停止当前 run 只撤销 steer，普通 queue 保持排队", () => {
    const ordinary = queued("queue-1", "queue");
    const steering = queued("steer-1", "steer", "verifying");

    const next = markSteeringCancelledForStop([ordinary, steering]);

    expect(next[0]).toBe(ordinary);
    expect(next[0]).toMatchObject({ deliveryMode: "queue", status: "queued" });
    expect(next[1]).toMatchObject({ deliveryMode: "steer", status: "cancelled" });
  });

  it("旧会话迟到 session 事件不能改写当前会话", () => {
    expect(shouldAcceptSessionEvent(
      { sessionId: "session-old", client_msg_id: "client-old" },
      "session-current",
      null,
    )).toBe(false);
    expect(shouldAcceptSessionEvent(
      { sessionId: "session-current", client_msg_id: "client-current" },
      "session-current",
      null,
    )).toBe(true);
  });

  it("新会话草稿只接受当前 clientMessageId 对应的 session", () => {
    expect(shouldAcceptSessionEvent(
      { sessionId: "session-old", client_msg_id: "client-old" },
      null,
      "client-current",
    )).toBe(false);
    expect(shouldAcceptSessionEvent(
      { sessionId: "session-current", client_msg_id: "client-current" },
      null,
      "client-current",
    )).toBe(true);
  });

  it("sync overflow 同时刷新列表与当前详情快照", async () => {
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    const refreshCurrentSession = vi.fn();

    await recoverQueueSnapshotAfterSyncOverflow({ loadSessions, refreshCurrentSession });

    expect(refreshCurrentSession).toHaveBeenCalledTimes(1);
    expect(loadSessions).toHaveBeenCalledWith({ fresh: true });
  });

  it("ACK 核验 not_found 后释放初始发送传输态", () => {
    const markFailed = vi.fn();
    const clearPendingSession = vi.fn();
    const releaseTransport = vi.fn();

    finalizeNotFoundSubmission({
      preserveActiveStream: false,
      markFailed,
      clearPendingSession,
      releaseTransport,
    });

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(clearPendingSession).toHaveBeenCalledTimes(1);
    expect(releaseTransport).toHaveBeenCalledTimes(1);
  });

  it("排队消息核验 not_found 不得释放当前 run 的传输态", () => {
    const markFailed = vi.fn();
    const clearPendingSession = vi.fn();
    const releaseTransport = vi.fn();

    finalizeNotFoundSubmission({
      preserveActiveStream: true,
      markFailed,
      clearPendingSession,
      releaseTransport,
    });

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(clearPendingSession).toHaveBeenCalledTimes(1);
    expect(releaseTransport).not.toHaveBeenCalled();
  });

  it("同一帧重复提交只执行一次外部副作用", async () => {
    const gate = { current: false };
    let releaseTask!: () => void;
    const waiting = new Promise<void>((resolve) => { releaseTask = resolve; });
    const sideEffect = vi.fn(async () => waiting);
    const submit = async () => {
      const release = acquireMessageSubmissionSlot(gate);
      if (!release) return false;
      try {
        await sideEffect();
        return true;
      } finally {
        release();
      }
    };

    const first = submit();
    const duplicate = submit();
    expect(sideEffect).toHaveBeenCalledTimes(1);
    await expect(duplicate).resolves.toBe(false);
    releaseTask();
    await expect(first).resolves.toBe(true);

    const next = submit();
    await expect(next).resolves.toBe(true);
    expect(sideEffect).toHaveBeenCalledTimes(2);
  });
});
