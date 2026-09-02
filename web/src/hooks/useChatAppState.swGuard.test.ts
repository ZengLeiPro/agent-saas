// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "useChatAppState.ts"), "utf8");

/**
 * 2026-08-02：SW 更新守门原先遍历 activeRunsBySession 的全部会话，只要有任何后台会话在跑
 * 就永久拦住 update-on-navigation，长期挂后台任务的用户的 tab 会一直锁在旧 bundle。
 * 后台 run 在服务端，整页跳转不打断它，守门必须收窄到当前会话。
 */
describe("SW 更新守门只看当前会话", () => {
  // 只截守门函数体：import 段也有同名标识符，结束锚点必须从守门起点之后再找
  const guardStart = SOURCE.indexOf("registerUpdateGuard(() => {");
  const guardSource = SOURCE.slice(
    guardStart,
    SOURCE.indexOf("registerBeforeReloadHook(", guardStart),
  );

  it("能定位到守门函数体（锚点未失效）", () => {
    expect(guardStart).toBeGreaterThan(0);
    expect(guardSource.length).toBeGreaterThan(0);
  });

  it("守门体内定位到当前会话，不再遍历全部会话运行态", () => {
    expect(guardSource).toContain("immediateSessionIdRef.current ?? sessionIdRef.current");
    expect(guardSource).toContain("activeRunsBySession.current.get(currentSessionId)?.status");
    expect(guardSource).not.toContain("activeRunsBySession.current.values()");
  });

  it("上传中 / 消息在途 / 当前会话 loading 仍然守门", () => {
    expect(guardSource).toContain("uploadingRef.current");
    expect(guardSource).toContain("outboxRef.current.length > 0");
    expect(guardSource).toContain("loadingRef.current");
  });
});
