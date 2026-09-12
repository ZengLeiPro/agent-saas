import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const retry = vi.fn();
const governanceError = Object.assign(new Error("private backend detail"), { status: 503 });
const authState = vi.hoisted(() => ({
  user: null as {
    username?: string;
    debugMode?: boolean;
    tenantFeatures?: { debugModeAllowed?: boolean; debugModeEnabled?: boolean };
  } | null,
}));

vi.mock("@/hooks/useEffectiveResources", () => ({
  useEffectiveResources: () => ({ data: null, loading: false, error: governanceError, retry }),
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => authState }));

import { FilesStorageSection, MyAgentSection, MyPermissionsSection } from "./V2Sections";

describe("我的 Agent", () => {
  it("人格定义不再作为跳转 Tab，资料卡负责打开编辑弹窗", () => {
    render(<MyAgentSection renderProfile={() => <div>资料卡</div>} renderMemory={() => <div>长期记忆</div>} />);

    expect(screen.getByText("在资料与长期 Memory 之间切换；深链刷新会保留当前 Tab。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看说明" }));
    expect(screen.getByRole("dialog").textContent).toContain("在资料与长期 Memory 之间切换；深链刷新会保留当前 Tab。");
    expect(screen.getByRole("tab", { name: "资料" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "长期 Memory" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Persona" })).toBeNull();
  });
});

describe("我的权限 fail-closed", () => {
  beforeEach(() => {
    authState.user = null;
  });

  it("503 时显示统一失败态，不泄露后端详情或本地推导允许", () => {
    render(<MyPermissionsSection />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("暂时无法加载我的权限");
    expect(alert.textContent).not.toContain("private backend detail");
  });

  it("不再重复展示调试模式区域，唯一开关留在对话与模型", () => {
    authState.user = {
      debugMode: false,
      tenantFeatures: { debugModeAllowed: true, debugModeEnabled: true },
    };
    render(<MyPermissionsSection />);

    expect(screen.queryByText("个人调试模式")).toBeNull();
    expect(screen.queryByText("详细执行过程")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("文件与存储", () => {
  it("展示与其他个人设置页一致的标准页头", () => {
    render(<FilesStorageSection renderFiles={() => <div>文件列表</div>} />);

    expect(screen.getByRole("heading", { level: 2, name: "文件与存储" })).toBeTruthy();
    expect(screen.getByText("文件列表")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "存储用量" })).toBeTruthy();
  });
});
