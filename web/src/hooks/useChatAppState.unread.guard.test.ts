import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "useChatAppState.ts"), "utf8");

describe("当前会话未读事件守卫", () => {
  it("标记当前会话已读后直接消费未读事件，避免通用处理器把红点写回 true", () => {
    expect(SOURCE).toMatch(
      /data\.type === 'session_read_state_changed'[\s\S]*?immediateSessionIdRef\.current === data\.sessionId[\s\S]*?markSessionRead\(data\.sessionId\);\s*return;[\s\S]*?processWsEvent\(/,
    );
  });
});
