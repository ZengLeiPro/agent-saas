import { describe, expect, it } from "vitest";
import SOURCE from "./useChatAppState.ts?raw";

describe("终态事件会话归属守卫", () => {
  it("终态收口与 lastRunState 恢复都以同步切换的 immediateSessionIdRef 为准", () => {
    expect(SOURCE).toContain("if (args.sessionId !== immediateSessionIdRef.current) return;");
    expect(SOURCE).toMatch(/if \(sessionId !== immediateSessionIdRef\.current\) \{[\s\S]*?return;\s*\}/);
  });

  it("共享 WS 处理器接收 immediateSessionIdRef，禁止切会话期间使用滞后的 React sessionId", () => {
    expect(SOURCE).toMatch(
      /processWsEvent\([\s\S]*?wsLatestSessionIdRef\.current,\s*immediateSessionIdRef\.current,\s*\)/,
    );
  });
});
