import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScenarioDeepLink, resetScenarioDeepLinkForTest } from "./useScenarioDeepLink";
import { makeWorkflowLibrary, makeWorkflowScenario } from "./workflowTestFixtures";

const target = makeWorkflowScenario("canonical-target");
const library = {
  ...makeWorkflowLibrary([target]),
  deferredObjects: [{ id: "deferred-old", kind: "workflow" as const, reason: "需要后续专项接入", status: "deferred" as const }],
  aliases: [
    {
      legacySlug: "legacy-target",
      resolution: "catalog" as const,
      targetCatalogScenarioId: "canonical-target",
      skinId: "skin-target",
      roleViewId: "view-target",
      roleId: "sales",
    },
    { legacySlug: "legacy-deferred", resolution: "deferred" as const, deferredObjectId: "deferred-old" },
  ],
};

vi.mock("./useScenarioLibrary", () => ({
  useScenarioLibrary: () => ({ library: null, workflowLibrary: library }),
}));

function Harness({ onPrefill, onOpen }: { onPrefill: (value: string) => void; onOpen: () => void }) {
  useScenarioDeepLink(onPrefill, onOpen);
  return null;
}

beforeEach(() => {
  resetScenarioDeepLinkForTest();
  window.history.replaceState({}, "", "/?scenario=legacy-target&intent=view");
});

describe("useScenarioDeepLink V3", () => {
  it("canonical-first/alias-second 解析旧 slug，并保留 canonical 工作流供目录打开", () => {
    const onOpen = vi.fn(() => window.history.pushState({}, "", "/capabilities"));
    render(<Harness onPrefill={vi.fn()} onOpen={onOpen} />);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(new URLSearchParams(window.location.search).get("workflow")).toBe("canonical-target");
    expect(window.location.pathname).toBe("/capabilities");
    expect(new URLSearchParams(window.location.search).get("scenario")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("skinId")).toBe("skin-target");
    expect(new URLSearchParams(window.location.search).get("roleViewId")).toBe("view-target");
    expect(new URLSearchParams(window.location.search).get("roleId")).toBe("sales");
  });

  it("D0 run 只预填短启动语，不携带旧 prompt 或继续打开目录", () => {
    window.history.replaceState({}, "", "/?workflow=canonical-target&intent=run");
    const onPrefill = vi.fn();
    const onOpen = vi.fn();
    render(<Harness onPrefill={onPrefill} onOpen={onOpen} />);
    expect(onPrefill).toHaveBeenCalledWith(target.launch.starterMessage);
    expect(onOpen).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("后置旧 slug 只打开明确状态说明，不预填或启动聊天", () => {
    window.history.replaceState({}, "", "/?scenario=legacy-deferred&intent=run");
    const onPrefill = vi.fn();
    const onOpen = vi.fn(() => window.history.pushState({}, "", "/capabilities"));
    render(<Harness onPrefill={onPrefill} onOpen={onOpen} />);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onPrefill).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get("workflow")).toBe("legacy-deferred");
    expect(new URLSearchParams(window.location.search).get("intent")).toBe("view");
  });
});
