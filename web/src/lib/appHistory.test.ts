import { beforeEach, describe, expect, it } from "vitest";

import { pushAppHistoryState, pushCurrentAppHistoryState, readAppHistoryIndex, replaceAppHistoryUrl } from "./appHistory";

beforeEach(() => {
  window.history.replaceState({ __personalSettingsV2: { source: "/", depth: 2 } }, "", "/platform-admin/settings/billing");
});

describe("app history index", () => {
  it("replace URL 保留设置来源状态并补 index", () => {
    replaceAppHistoryUrl("#tab=pricing");

    expect(window.history.state.__personalSettingsV2).toEqual({ source: "/", depth: 2 });
    expect(readAppHistoryIndex()).toBe(0);
    expect(window.location.hash).toBe("#tab=pricing");
  });

  it("push 在当前 index 上递增", () => {
    replaceAppHistoryUrl("#tab=overview");
    pushAppHistoryState({}, "/platform-admin/settings/billing#tab=audit");

    expect(readAppHistoryIndex()).toBe(1);
  });

  it("页内筛选 push 保留设置来源状态", () => {
    pushCurrentAppHistoryState({}, "/platform-admin/settings/billing?tenant=t1");

    expect(window.history.state.__personalSettingsV2).toEqual({ source: "/", depth: 2 });
    expect(readAppHistoryIndex()).toBe(1);
  });
});
