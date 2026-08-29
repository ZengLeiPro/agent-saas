import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "useChatAppState.ts"), "utf8");
const POLICY = readFileSync(join(__dirname, "useApprovalTierRunPolicy.ts"), "utf8");
const DESKTOP = readFileSync(join(__dirname, "../layouts/DesktopLayout.tsx"), "utf8");
const MOBILE = readFileSync(join(__dirname, "../layouts/MobileLayout.tsx"), "utf8");

/**
 * TASK-256 review 返工：Web 端必须消费统一的三档「有效批准策略」。
 * 此前 useChatAppState / Desktop / Mobile 只判断 authorizationModeEnabled === true：
 * 1. 缺失字段的老用户被当作 ask，与服务端 ?? true 默认（full）不一致；
 * 2. 账户档位过去只对当前会话 best-effort 发 WS，其他 active run 保留旧策略；
 * 3. 三轮返工后服务端保存偏好时原子收敛全部 active run，前端账户 effect 不再发 WS。
 * 会话级覆盖逻辑仍抽在 useApprovalTierRunPolicy，本守卫同时覆盖两处源码。
 */
describe("三档有效批准策略统一传播", () => {
  it("useChatAppState 经 resolveApprovalTier 取档，不再用 === true 直读布尔", () => {
    expect(SOURCE).toContain("resolveApprovalTier(user?.preferences)");
    expect(SOURCE).not.toContain("authorizationModeEnabled === true");
    expect(SOURCE).toContain("useApprovalTierRunPolicy({");
  });

  it("账户档位 effect 只同步展示态，不再 best-effort 发送当前会话 WS", () => {
    const marker = POLICY.indexOf("账户档位只同步本地展示态");
    expect(marker).toBeGreaterThan(0);
    const effect = POLICY.slice(marker, POLICY.indexOf("}, [approvalTier, setAutoApproveRunShellState]);", marker));
    expect(effect).not.toContain("ensureConnectedSend");
    expect(POLICY).toContain("}, [approvalTier, setAutoApproveRunShellState]);");
  });

  it("低风险档的会话级覆盖与新消息都显式携带 lowRiskOnly", () => {
    // ask 档会话开关/低风险显示态路径维持 lowRiskOnly，不升为全量自动批准
    expect(POLICY).toContain('approvalTier === "low-risk"');
    expect(POLICY).toContain('approvalPolicyPayloadForTier("low-risk")');
    // 新消息路径按 approvalTierRef 表达，不依赖服务端兜底
    expect(SOURCE).toContain('approvalTierRef.current === "low-risk"');
    const messageStart = SOURCE.indexOf('approvalTierRef.current === "low-risk"');
    expect(SOURCE.slice(messageStart - 400, messageStart + 300)).toContain("approvalPolicy");
  });

  it("会话级「自动授权工具」开关仅在 ask 档展示（Desktop / Mobile 同语义）", () => {
    expect(DESKTOP).toContain('canAutoApproveRunShell={approvalTier === "ask"}');
    expect(MOBILE).toContain('canAutoApproveRunShell={approvalTier === "ask"}');
    expect(DESKTOP).toContain("resolveApprovalTier(authUser?.preferences)");
    expect(MOBILE).toContain("resolveApprovalTier(authUser?.preferences)");
  });
});
