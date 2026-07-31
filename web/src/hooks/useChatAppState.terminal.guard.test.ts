import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "useChatAppState.ts"), "utf8");

describe("终态事件会话归属守卫", () => {
  it("终态收口与 lastRunState 恢复都以同步切换的 immediateSessionIdRef 为准", () => {
    expect(SOURCE).toContain("if (args.sessionId !== immediateSessionIdRef.current) return;");
    expect(SOURCE).toContain("if (sessionId !== immediateSessionIdRef.current) return;");
  });

  it("共享 WS 处理器接收 immediateSessionIdRef，禁止切会话期间使用滞后的 React sessionId", () => {
    expect(SOURCE).toMatch(
      /processWsEvent\([\s\S]*?wsLatestSessionIdRef\.current,\s*immediateSessionIdRef\.current,\s*\)/,
    );
  });
});
