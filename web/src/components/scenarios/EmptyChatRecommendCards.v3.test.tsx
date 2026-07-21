import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyChatRecommendCards } from "./EmptyChatRecommendCards";
import { makeWorkflowLibrary, makeWorkflowScenario } from "./workflowTestFixtures";

const d0 = makeWorkflowScenario("d0-current", { title: "当前可运行工作流" });
const d1 = makeWorkflowScenario("d1-connector", {
  title: "需要标准接入工作流",
  readiness: "D1_CONNECTOR",
  launch: { sampleAvailable: false, startMode: "connector", starterMessage: "接入后启动" },
  cta: { primary: "接入我的系统", secondary: "查看工作流" },
});
const library = makeWorkflowLibrary([d0, d1]);

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

    fireEvent.click(screen.getByRole("button", { name: /当前可运行工作流/ }));
    expect(onStartWorkflow).toHaveBeenCalledWith(d0.launch.starterMessage, d0);
    expect(onViewAll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /需要标准接入工作流/ }));
    expect(onViewAll).toHaveBeenCalledOnce();
    expect(onStartWorkflow).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(window.location.search);
    expect(params.get("workflow")).toBe("d1-connector");
    expect(params.get("intent")).toBe("connect");
  });
});
