import { describe, expect, it } from "vitest";
import SOURCE from "./useChatAppState.ts?raw";

describe("当前会话未读事件守卫", () => {
  it("标记当前会话已读后直接消费未读事件，避免通用处理器把红点写回 true", () => {
    expect(SOURCE).toMatch(
      /data\.type === 'session_read_state_changed'[\s\S]*?immediateSessionIdRef\.current === data\.sessionId[\s\S]*?markSessionRead\(data\.sessionId\);\s*return;[\s\S]*?processWsEvent\(/,
    );
  });

  it("已读请求禁止携带 credentials: 'include'（authFetch 走 Authorization header；分域部署下 credentialed CORS preflight 会被浏览器拦截）", () => {
    expect(SOURCE).not.toMatch(/credentials:\s*['"]include['"]/);
  });

  it('打开会话但不在底部/不可见时不清，回到底部才通过 canonical selector 原子标记', () => {
    expect(SOURCE).toMatch(/selectSessionUnread\([\s\S]*?visible:[\s\S]*?atBottom: msg\.isNearBottomRef\.current/);
    expect(SOURCE).toMatch(/if \(!unread\.shouldMarkSeen\) return;[\s\S]*?\/read/);
    expect(SOURCE).toMatch(/addEventListener\('scroll', attempt/);
  });
});
