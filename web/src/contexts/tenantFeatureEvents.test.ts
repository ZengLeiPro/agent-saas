import { describe, expect, it } from "vitest";

import { tenantFeatureUpdatesFromEnvelope } from "./tenantFeatureEvents";

const features = {
  filesEnabled: true,
  cronEnabled: true,
  mcpEnabled: true,
  customSkillsEnabled: true,
  debugModeAllowed: false,
  debugModeEnabled: false,
};

describe("tenantFeatureUpdatesFromEnvelope", () => {
  it("读取当前组织的上级关闭事件并携带有效个人状态", () => {
    expect(tenantFeatureUpdatesFromEnvelope({
      data: { type: "tenant_features_changed", tenantId: "tenant-a", tenantFeatures: features, debugMode: false },
    }, "tenant-a")).toEqual([{ tenantId: "tenant-a", tenantFeatures: features, debugMode: false }]);
  });

  it("从 sync_ok 回放事件恢复跨会话设置，忽略其他组织", () => {
    expect(tenantFeatureUpdatesFromEnvelope({
      data: {
        type: "sync_ok",
        seq: 3,
        events: [
          { seq: 2, event: { type: "tenant_features_changed", tenantId: "tenant-b", tenantFeatures: features, debugMode: false } },
          { seq: 3, event: { type: "tenant_features_changed", tenantId: "tenant-a", tenantFeatures: features, debugMode: false } },
        ],
      },
    }, "tenant-a")).toHaveLength(1);
  });
});
