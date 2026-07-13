import { describe, expect, it } from "vitest";

import { resolveNewSessionTarget } from "./orgAgentSessionRouting";

describe("resolveNewSessionTarget", () => {
  it("当前专职 Agent 可用时继续新建同一 Agent 会话", () => {
    expect(resolveNewSessionTarget({
      activeOrgAgentId: "agent-2",
      availableOrgAgentIds: ["agent-1", "agent-2"],
      personalAgentEnabled: true,
    })).toEqual({ kind: "org-agent", agentId: "agent-2" });
  });

  it("个人 Agent 可用且当前不是专职 Agent 时保留个人新会话", () => {
    expect(resolveNewSessionTarget({
      availableOrgAgentIds: ["agent-1"],
      personalAgentEnabled: true,
    })).toEqual({ kind: "personal" });
  });

  it("个人 Agent 停用且只有一个专职 Agent 时直接进入该 Agent", () => {
    expect(resolveNewSessionTarget({
      availableOrgAgentIds: ["agent-1"],
      personalAgentEnabled: false,
    })).toEqual({ kind: "org-agent", agentId: "agent-1" });
  });

  it("个人 Agent 停用且有多个专职 Agent 时打开选择器", () => {
    expect(resolveNewSessionTarget({
      availableOrgAgentIds: ["agent-1", "agent-2"],
      personalAgentEnabled: false,
    })).toEqual({ kind: "picker" });
  });

  it("个人 Agent 停用且没有可用专职 Agent 时不进入空白个人会话", () => {
    expect(resolveNewSessionTarget({
      activeOrgAgentId: "disabled-agent",
      availableOrgAgentIds: [],
      personalAgentEnabled: false,
    })).toEqual({ kind: "unavailable" });
  });

});
