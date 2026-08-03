import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "useChatAppState.ts"), "utf8");

function sourceBetween(start: string, end: string): string {
  const startIndex = SOURCE.indexOf(start);
  const endIndex = SOURCE.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return SOURCE.slice(startIndex, endIndex);
}

describe("会话级 durable cursor 生命周期", () => {
  it("新 run、终态与手动压缩只重置 run 内 eventId，不清空 durable cursor", () => {
    const sendChat = sourceBetween("const sendChatViaWs =", "// 同步 sendChatViaWs 到 ref");
    const terminal = sourceBetween("const finalizeTerminalRuntime =", "const reconcileLastRunState =");
    const compact = sourceBetween("const compactSession =", "const sendMessage =");

    for (const block of [sendChat, terminal, compact]) {
      expect(block).toContain("lastEventIdRef.current = null");
      expect(block).not.toContain("lastEventCursorRef.current = null");
      expect(block).not.toContain("lastEventCursor: null");
    }
  });

  it("跨设备新流从已保存的 durable cursor 继续增量回放", () => {
    const streamStarted = sourceBetween("if (data.type === 'stream_started')", "// 防串流守卫");
    expect(streamStarted).toContain("lastEventCursor: lastEventCursorRef.current");
    expect(streamStarted).not.toContain("lastEventCursor: null");
  });
});
