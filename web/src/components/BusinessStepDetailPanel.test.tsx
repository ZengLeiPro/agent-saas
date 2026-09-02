import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BusinessStepEventItem, BusinessStepSection, RenderItem, TodoItem } from "@agent/shared";

import { BusinessStepDetailPanel, BusinessStepDetailSheet } from "./BusinessStepDetailPanel";
import type { BusinessStepDetailView, BusinessStepPlanView } from "./businessStepViewModel";

const todo: TodoItem = {
  id: "verify",
  kind: "business",
  content: "核验订单",
  status: "completed",
  outcome: {
    text: "17 张通过，1 张需复核",
    tone: "warn",
    stat: [{ label: "通过", value: "17" }, { label: "复核", value: "1" }],
  },
  detail: [{ insight: "税号格式存在一处差异", label: "关键发现" }],
  display: [
    {
      kind: "records",
      layout: "comparison",
      title: "订单差异",
      items: [{ label: "税号", baseline: "A-01", current: "A-02", delta: "不一致", tone: "warn" }],
    },
    {
      kind: "gate",
      title: "伪造的人审入口",
      actions: [{ kind: "primary", label: "批准", interactionId: "fake-approval" }],
    },
  ],
  evidenceRefs: ["order:SO-1001", "receipt:check-18"],
};

const start: BusinessStepEventItem = {
  type: "business_step",
  id: "start-verify",
  anchorMessageId: "todo-start",
  kind: "start",
  todo: { ...todo, status: "in_progress" },
  stepIndex: 1,
  stepCount: 2,
};

const terminal: BusinessStepEventItem = {
  type: "business_step",
  id: "complete-verify",
  anchorMessageId: "todo-done",
  kind: "complete",
  todo,
  stepIndex: 1,
  stepCount: 2,
};

const processTool: RenderItem = {
  id: "read-order",
  type: "tool_use",
  toolName: "Read",
  toolId: "read-order",
  toolInput: "{}",
  executionStatus: "completed",
  resultReady: true,
  result: "ok",
};

const connectorAction: RenderItem = {
  id: "write-action",
  type: "tool_use",
  toolName: "DwsBusiness",
  toolId: "write-action",
  toolInput: "{}",
  executionStatus: "completed",
  resultReady: true,
  result: "ok",
  presentation: {
    title: "钉钉 · 更新订单",
    status: "ok",
    connector: { system: "钉钉", write: true },
  },
};

const artifact: RenderItem = {
  id: "artifact-1",
  type: "file_download",
  fileName: "核验结果.xlsx",
  fileType: "xlsx",
  filePath: "assets/核验结果.xlsx",
  fileSize: 1024,
  artifactId: "artifact-1",
};

const section: BusinessStepSection = {
  type: "business_step_section",
  id: "section-verify",
  start,
  terminal,
  items: [processTool, connectorAction, artifact],
  isActive: false,
  processAnomaly: true,
  systemActionIds: ["write-action"],
};

const detail: BusinessStepDetailView = {
  planId: "plan-1",
  todoKey: "id:verify",
  todo,
  stepIndex: 1,
  stepCount: 2,
  sections: [section],
  terminal,
};

const secondTodo: TodoItem = {
  id: "write",
  kind: "business",
  content: "写入结果",
  status: "in_progress",
};

const plan: BusinessStepPlanView = {
  event: {
    type: "business_step",
    id: "plan-1",
    anchorMessageId: "todo-start",
    kind: "plan",
    todos: [todo, secondTodo],
    stepCount: 2,
  },
  details: [detail, {
    planId: "plan-1",
    todoKey: "id:write",
    todo: secondTodo,
    stepIndex: 2,
    stepCount: 2,
    sections: [],
  }],
  currentTodoKey: "id:write",
};

function renderItem(item: RenderItem) {
  return <div data-rendered-process-item={item.id}>{item.id}</div>;
}

function props() {
  return {
    detail,
    plan,
    followMode: "fixed" as const,
    debugMode: true,
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onReturnCurrent: vi.fn(),
    onClose: vi.fn(),
    renderItem,
  };
}

describe("BusinessStepDetailPanel", () => {
  it("默认显示结果，并复用只读 PresentationBlocks 与正式交付物", () => {
    render(<BusinessStepDetailPanel {...props()} />);

    expect(document.querySelector(".business-step-records-container")).toBeTruthy();
    expect(document.querySelector("[data-records-block]")?.className).toContain("business-step-comparison-scroll");
    expect(screen.getByText("17 张通过，1 张需复核")).toBeTruthy();
    expect(screen.getByText("订单差异")).toBeTruthy();
    expect(screen.getByText("税号格式存在一处差异")).toBeTruthy();
    expect(screen.getByText("artifact-1")).toBeTruthy();
    expect(screen.getByText(/过程记录中仍有异常/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "批准" })).toHaveProperty("disabled", true);
    expect(screen.getByText("已暂停跟随")).toBeTruthy();
    expect(screen.getByRole("button", { name: "返回当前步骤" })).toBeTruthy();
  });

  it("结果、过程、依据按真实内容分区，空内容不伪造", () => {
    render(<BusinessStepDetailPanel {...props()} />);

    fireEvent.click(screen.getByRole("tab", { name: "过程" }));
    expect(screen.getByLabelText("步骤过程")).toBeTruthy();
    expect(screen.getByText("read-order")).toBeTruthy();
    expect(screen.getByText("write-action")).toBeTruthy();
    expect(screen.queryByText("artifact-1")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "依据" }));
    expect(screen.getByText("order:SO-1001")).toBeTruthy();
    expect(screen.getByText("receipt:check-18")).toBeTruthy();
  });

  it("非 debug 终态仍保留安全过程摘要与外部写操作", () => {
    render(<BusinessStepDetailPanel {...props()} debugMode={false} />);
    fireEvent.click(screen.getByRole("tab", { name: "过程" }));

    expect(screen.getByText("read-order")).toBeTruthy();
    expect(screen.getByText("write-action")).toBeTruthy();
  });

  it("提供上一步、下一步与返回当前步骤控制", () => {
    const callbacks = props();
    render(<BusinessStepDetailPanel {...callbacks} />);

    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "返回当前步骤" }));
    expect(callbacks.onPrevious).toHaveBeenCalledTimes(1);
    expect(callbacks.onNext).toHaveBeenCalledTimes(1);
    expect(callbacks.onReturnCurrent).toHaveBeenCalledTimes(1);
  });

  it("只有结果时隐藏空 Tab", () => {
    const resultOnly = { ...detail, todo: { ...todo, display: undefined, detail: undefined, evidenceRefs: undefined }, sections: [] };
    render(<BusinessStepDetailPanel {...props()} detail={resultOnly} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText("17 张通过，1 张需复核")).toBeTruthy();
  });
});

describe("BusinessStepDetailSheet", () => {
  it("使用顶部留白、100dvh、safe-area 与高于父 Dialog 的专用底部层", () => {
    render(<BusinessStepDetailSheet {...props()} open />);
    const sheet = document.querySelector<HTMLElement>("[data-business-step-detail-sheet]");
    const overlay = sheet?.previousElementSibling as HTMLElement | null;
    expect(sheet).toBeTruthy();
    expect(sheet?.className).toContain("top-3");
    expect(sheet?.className).toContain("z-[111]");
    expect(sheet?.className).toContain("h-[calc(100dvh-0.75rem)]");
    expect(sheet?.className).toContain("rounded-t-[24px]");
    expect(sheet?.className).toContain("rounded-b-none");
    expect(sheet?.className).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(overlay?.className).toContain("z-[110]");
    expect(sheet?.querySelector("[role=tabpanel]")?.className).toContain("overscroll-contain");
  });

  it("ESC、遮罩与明确关闭按钮都能关闭 Sheet", () => {
    const callbacks = props();
    const { rerender } = render(<BusinessStepDetailSheet {...callbacks} open />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);

    const overlayCallbacks = props();
    rerender(<BusinessStepDetailSheet {...overlayCallbacks} open />);
    const content = screen.getByRole("dialog");
    const overlay = content.previousElementSibling as HTMLElement;
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(overlayCallbacks.onClose).toHaveBeenCalledTimes(1);

    const nextCallbacks = props();
    rerender(<BusinessStepDetailSheet {...nextCallbacks} open />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(nextCallbacks.onClose).toHaveBeenCalledTimes(1);
  });

  it("窄屏 comparison 使用纵向字段结构且不产生横向滚动", () => {
    render(<BusinessStepDetailSheet {...props()} open />);
    const comparison = document.querySelector<HTMLElement>("[data-records-block]");
    const row = document.querySelector<HTMLElement>("[data-comparison-row] [data-comparison-track]");
    expect(comparison?.className).toContain("overflow-x-hidden");
    expect(comparison?.getAttribute("tabindex")).toBeNull();
    expect(row?.className).toContain("grid-cols-1");
    expect(screen.getByText("字段")).toBeTruthy();
    expect(screen.getAllByText("基准/之前").length).toBeGreaterThan(0);
    expect(screen.getAllByText("当前/实际").length).toBeGreaterThan(0);
    expect(screen.getAllByText("差异").length).toBeGreaterThan(0);
  });
});
