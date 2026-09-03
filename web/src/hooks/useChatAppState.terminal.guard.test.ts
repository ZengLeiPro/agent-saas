import { describe, expect, it } from "vitest";
import SOURCE from "./useChatAppState.ts?raw";

describe("终态事件的会话归属守卫", () => {
  it("终态收口与 lastRunState 恢复都以同步切换的 immediateSessionIdRef 为准", () => {
    expect(SOURCE).toContain("if (args.sessionId !== immediateSessionIdRef.current) return;");
    expect(SOURCE).toMatch(/if \(sessionId !== immediateSessionIdRef\.current\) \{[\s\S]*?return;\s*\}/);
  });

  it("共享 WS 处理器优先接收 immediateSessionIdRef，并以当前 session 作为稳定回退", () => {
    expect(SOURCE).toMatch(
      /processWsEvent\([\s\S]*?wsLatestSessionIdRef\.current,\s*immediateSessionIdRef\.current \?\? sessionIdRef\.current,\s*\)/,
    );
  });
});
