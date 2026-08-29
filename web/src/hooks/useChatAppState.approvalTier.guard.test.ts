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
 * 2. ask->low-risk 档位切换不触发 approval_policy effect，活跃 run 仍是「每次询问」；
 * 3. full->low-risk 发送 autoApproveTools:false，服务端把 metadata.approvalPolicy
 *    写成 null，活跃 run 被降为「每次询问」而不是低风险档。
 * 传播逻辑现抽出为 useApprovalTierRunPolicy，本守卫同时覆盖两处源码。
 */
describe("三档有效批准策略统一传播", () => {
  it("useChatAppState 经 resolveApprovalTier 取档，不再用 === true 直读布尔", () => {
    expect(SOURCE).toContain("resolveApprovalTier(user?.preferences)");
    expect(SOURCE).not.toContain("authorizationModeEnabled === true");
    expect(SOURCE).toContain("useApprovalTierRunPolicy({");
  });

  it("approval_policy effect 依赖 approvalTier，档位切换（含 ask->low-risk）都会触发", () => {
    expect(POLICY).toContain("const sendCurrentRunPolicy = (approvalPolicy");
    expect(POLICY).toContain("approvalPolicyPayloadForTier(approvalTier)");
    expect(POLICY).toContain("autoApproveTools: false");
    // effect 依赖数组必须含 approvalTier，否则 ask->low-risk 不触发
    expect(POLICY).toContain("}, [approvalTier, activeRunsBySession, sessionIdRef, setAutoApproveRunShellState]);");
  });

  it("低风险档向活跃 run 与新消息都显式携带 lowRiskOnly", () => {
    // 活跃 run：会话开关拨动也维持 lowRiskOnly，不升为全量自动批准
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
