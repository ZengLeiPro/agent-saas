import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/hooks/useChatAppState.ts"), "utf8");

describe("会话消息队列一致性守卫", () => {
  it("运行中普通发送默认 queue，显式插话才使用 steer", () => {
    expect(source).toContain("submitCurrentMessage('queue')");
    expect(source).toContain("submitCurrentMessage('steer')");
    expect(source).toContain("deliveryMode: 'queue' | 'steer' = 'queue'");
  });

  it("ACK 超时先查询权威状态，不直接标记发送失败", () => {
    const timeoutStart = source.indexOf("const armAckTimeout");
    const sendStart = source.indexOf("const sendChatViaWs", timeoutStart);
    const timeoutBody = source.slice(timeoutStart, sendStart);

    expect(timeoutBody).toContain("/api/messages/${encodeURIComponent(clientMsgId)}/status");
    expect(timeoutBody).toContain("status: 'verifying'");
    expect(timeoutBody).toContain("if (!currentEntry || currentEntry.state === 'acked') return");
    expect(timeoutBody).not.toContain("发送超时，请重试");
  });

  it("未挂流时仍放行 durable ACK 与队列事件", () => {
    const guardStart = source.indexOf("if (!wsAttachedRef.current)");
    const watchdogStart = source.indexOf("// 流式事件到达", guardStart);
    const guardBody = source.slice(guardStart, watchdogStart);

    expect(guardBody).toContain("data.type === 'chat_ack'");
    expect(guardBody).toContain("data.type === 'message_queued'");
  });

  it("sync 重放恢复并撤销队列事件", () => {
    const syncStart = source.indexOf("if (data.type === 'sync_ok')");
    const overflowStart = source.indexOf("if (data.type === 'sync_overflow')", syncStart);
    const syncBody = source.slice(syncStart, overflowStart);

    expect(syncBody).toContain("e.type === 'message_queued'");
    expect(syncBody).toContain("e.type === 'steering_queued'");
    expect(syncBody).toContain("e.type === 'steering_cancelled'");
  });

  it("切会话清理本地传输态，由 durable detail 快照恢复", () => {
    const detachStart = source.indexOf("const detachFromStream");
    const callbacksStart = source.indexOf("const sessionCallbacks", detachStart);
    const detachBody = source.slice(detachStart, callbacksStart);

    expect(detachBody).toContain("ackTimersRef.current.clear()");
    expect(detachBody).toContain("outboxRef.current = []");
    expect(detachBody).toContain("mutateQueuedInterjections(() => [])");
  });
});
