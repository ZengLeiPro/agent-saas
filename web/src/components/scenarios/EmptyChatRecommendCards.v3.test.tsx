import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyChatRecommendCards } from "./EmptyChatRecommendCards";
import { makeWorkflowLibrary, makeWorkflowScenario } from "./workflowTestFixtures";

const d0 = makeWorkflowScenario("d0-current", { title: "当前可运行工作流" });
const d1 = makeWorkflowScenario("d1-connector", {
  title: "需要标准接入工作流",
  readiness: "D1_CONNECTOR",
  launch: {
    sampleAvailable: false,
    startMode: "connector",
    entry: { kind: "business_event", content: "业务系统出现一条待处理事件。" },
    starterMessage: "业务系统出现一条待处理事件。",
  },
  cta: { primary: "接入我的系统", secondary: "查看工作流" },
});
const demo = makeWorkflowScenario("demo-with-script", {
  title: "有剧本的工作流",
  cta: { primary: "接入这个流程", secondary: "查看工作流" },
  presentation: {
    version: 1,
    dataLabel: "合成场景演示",
    limitation: "演示数据均为虚构。",
    chapters: [
      {
        id: "only",
        title: "读取并回写",
        narration: "读取客户资料并回写状态。",
        result: "状态已回写。",
        interaction: { kind: "next", label: "下一步" },
        surface: {
          kind: "crm_table",
          title: "客户关系系统",
          items: [{ label: "状态", value: "已回写", state: "success", changed: true }],
        },
      },
    ],
  },
});
const library = makeWorkflowLibrary([d0, d1, demo]);

vi.mock("./useScenarioLibrary", () => ({
  useScenarioLibrary: () => ({ library: null, workflowLibrary: library, loading: false, error: null }),
  matchRoleIdByPosition: () => null,
  pickRecommendedWorkflowScenarios: (items: typeof library.scenarios) => items,
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: null }) }));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("EmptyChatRecommendCards V3", () => {
  it("D0 预填短启动语，D1 进入目录接入路径而不启动聊天", () => {
    const onStartWorkflow = vi.fn();
    const onViewAll = vi.fn(() => window.history.pushState({}, "", "/capabilities"));
    render(<EmptyChatRecommendCards onTryScenario={vi.fn()} onStartWorkflow={onStartWorkflow} onViewAll={onViewAll} />);

    fireEvent.click(screen.getByRole("button", { name: "立即试一试" }));
    expect(onStartWorkflow).toHaveBeenCalledWith(d0.launch.starterMessage, d0);
    expect(onViewAll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "接入我的系统" }));
    expect(onViewAll).toHaveBeenCalledOnce();
    expect(onStartWorkflow).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(window.location.search);
    expect(params.get("workflow")).toBe("d1-connector");
    expect(params.get("intent")).toBe("connect");
  });

  it("有剧本的场景在第一屏只给虚构回放入口", () => {
    const onStartWorkflow = vi.fn();
    const onViewAll = vi.fn(() => window.history.pushState({}, "", "/capabilities"));
    render(<EmptyChatRecommendCards onTryScenario={vi.fn()} onStartWorkflow={onStartWorkflow} onViewAll={onViewAll} />);

    // 只有带剧本的那张卡长出演示入口，另外两张不受影响
    const replayButtons = screen.getAllByRole("button", { name: "看虚构回放" });
    expect(replayButtons).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "接入这个流程" })).toBeNull();

    fireEvent.click(replayButtons[0]);
    expect(onViewAll).toHaveBeenCalledOnce();
    expect(onStartWorkflow).not.toHaveBeenCalled();
    const params = new URLSearchParams(window.location.search);
    expect(params.get("workflow")).toBe("demo-with-script");
    expect(params.get("intent")).toBe("presentation");
  });
});
