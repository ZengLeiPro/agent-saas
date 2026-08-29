import { describe, expect, it } from "vitest";

import {
  approvalPolicyPayloadForTier,
  resolveApprovalTier,
} from "./approvalTier";

/**
 * TASK-256：三档「有效批准策略」必须与服务端 userPreferenceResolvers 的
 * resolveUserAutoApproveTools / resolveUserLowRiskAutoApprove 同语义：
 * authorizationModeEnabled 缺失时默认开启全部授权（?? true），
 * 低风险档仅在全部授权关闭时生效。
 */
describe("resolveApprovalTier", () => {
  it("缺失 authorizationModeEnabled（老用户）默认全部授权，与服务端 ?? true 一致", () => {
    expect(resolveApprovalTier(undefined)).toBe("full");
    expect(resolveApprovalTier(null)).toBe("full");
    expect(resolveApprovalTier({})).toBe("full");
    expect(resolveApprovalTier({ lowRiskToolsAutoApproveEnabled: true })).toBe("full");
  });

  it("全部授权关闭时，低风险偏好决定 low-risk / ask", () => {
    expect(resolveApprovalTier({ authorizationModeEnabled: false, lowRiskToolsAutoApproveEnabled: true })).toBe("low-risk");
    expect(resolveApprovalTier({ authorizationModeEnabled: false, lowRiskToolsAutoApproveEnabled: false })).toBe("ask");
    expect(resolveApprovalTier({ authorizationModeEnabled: false })).toBe("ask");
  });

  it("全部授权显式开启时恒为 full，低风险偏好不参与", () => {
    expect(resolveApprovalTier({ authorizationModeEnabled: true, lowRiskToolsAutoApproveEnabled: true })).toBe("full");
    expect(resolveApprovalTier({ authorizationModeEnabled: true })).toBe("full");
  });
});

describe("approvalPolicyPayloadForTier", () => {
  it("full 档不带 lowRiskOnly；low-risk 档带 lowRiskOnly；ask 档为关闭指令", () => {
    expect(approvalPolicyPayloadForTier("full")).toEqual({ autoApproveTools: true });
    expect(approvalPolicyPayloadForTier("low-risk")).toEqual({ autoApproveTools: true, lowRiskOnly: true });
    expect(approvalPolicyPayloadForTier("ask")).toEqual({ autoApproveTools: false });
  });
});
