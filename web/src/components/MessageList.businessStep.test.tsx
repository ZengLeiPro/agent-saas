import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { MessageItem } from "@agent/shared";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: "user-1",
      username: "tester",
      tenantId: "tenant-a",
      debugMode: false,
      tenantFeatures: { debugModeAllowed: true, debugModeEnabled: true },
      preferences: {},
    },
  }),
}));

vi.mock("@/hooks/useVoicePlayer", () => ({
  useVoicePlayer: () => ({
    activeId: null,
    getState: () => "idle",
    play: vi.fn(),
    togglePause: vi.fn(),
    stop: vi.fn(),
  }),
}));

import { MessageList } from "./MessageList";

beforeAll(() => {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
});

function todoSnapshot(id: string, todos: unknown[], runId: string | null = "run-1"): MessageItem {
  return {
    id,
    type: "tool_use",
    toolName: "TodoWrite",
    toolId: id,
    ...(runId ? { runId } : {}),
    toolInput: JSON.stringify({ todos }),
    executionStatus: "completed",
    resultReady: true,
    result: "ok",
  };
}

const pending = {
  verify: { id: "verify", kind: "business", content: "核验订单", status: "in_progress" },
  write: { id: "write", kind: "business", content: "写入结果", status: "pending" },
  archive: { id: "archive", kind: "business", content: "归档凭据", status: "pending" },
};

function workflowMessages(stage: 1 | 2 | 3 = 2): MessageItem[] {
  const result: MessageItem[] = [
    { id: "user-1", type: "user", content: "核验订单" },
    todoSnapshot("todo-start", [pending.verify, pending.write, pending.archive]),
    {
      id: "read-order",
      type: "tool_use",
      toolName: "Read",
      toolId: "read-order",
      toolInput: "{}",
      executionStatus: "completed",
      resultReady: true,
      result: "18 rows",
    },
    {
      id: "write-check-receipt",
      type: "tool_use",
      toolName: "DwsBusiness",
      toolId: "write-check-receipt",
      toolInput: "{}",
      executionStatus: "completed",
      resultReady: true,
      result: "ok",
      presentation: {
        title: "钉钉 · 记录核验回执",
        status: "ok",
        connector: { system: "钉钉", write: true },
      },
    },
    {
      id: "artifact-result",
      type: "file_download",
      fileName: "订单核验结果.xlsx",
      fileType: "xlsx",
      filePath: "assets/订单核验结果.xlsx",
      fileSize: 2048,
      artifactId: "artifact-result",
    },
  ];

  if (stage >= 2) {
    result.push(todoSnapshot("todo-progress", [
      {
        ...pending.verify,
        status: "completed",
        outcome: { text: "17 张通过，1 张待复核", tone: "warn", stat: [{ label: "通过", value: "17" }] },
        detail: [{ insight: "发现一处税号差异", label: "关键发现" }],
        display: [{ type: "facts", title: "核验统计", items: [{ label: "订单", value: "18" }] }],
        evidenceRefs: ["receipt:verify-18"],
      },
      { ...pending.write, status: "in_progress", activeForm: "正在写入核验结果" },
      pending.archive,
    ]));
    result.push({
      id: "write-file",
      type: "tool_use",
      toolName: "Write",
      toolId: "write-file",
      toolInput: "{}",
      executionStatus: "completed",
      resultReady: true,
      result: "ok",
    });
  }

  if (stage >= 3) {
    result.push(todoSnapshot("todo-archive", [
      {
        ...pending.verify,
        status: "completed",
        outcome: { text: "17 张通过，1 张待复核", tone: "warn" },
        evidenceRefs: ["receipt:verify-18"],
      },
      { ...pending.write, status: "completed", outcome: { text: "结果文件已写入", tone: "ok" } },
      { ...pending.archive, status: "in_progress", activeForm: "正在归档凭据" },
    ]));
  }

  return result;
}

function Harness({
  messages,
  sessionId = "session-a",
  debugMode = false,
}: {
  messages: MessageItem[];
  sessionId?: string;
  debugMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div>
      <div className="h-[600px]">
        <MessageList
          messages={messages}
          loading={messages.some((message) => message.id === "todo-start")}
          sessionId={sessionId}
          debugModeOverride={debugMode}
          businessStepDetailMode="desktop"
          businessStepDetailHost={host}
          businessStepPanelOpen={open}
          onBusinessStepPanelOpenChange={setOpen}
        />
      </div>
      <div ref={setHost} data-testid="detail-host" />
      <button type="button" onClick={() => setOpen(false)}>打开其他面板</button>
    </div>
  );
}

describe("MessageList 业务步骤主从视图、历史稳定性与 Run 隔离", () => {
  it("同一 Run 的多次 TodoWrite 快照只生成一个主卡，每个步骤只出现一次", () => {
    const { container } = render(<Harness messages={workflowMessages(3)} />);

    const planCard = container.querySelector<HTMLElement>("[data-business-step-plan]");
    expect(planCard).toBeTruthy();
    expect(container.querySelectorAll("[data-business-step-plan]")).toHaveLength(1);
    expect(within(planCard!).getAllByText("核验订单")).toHaveLength(1);
    expect(within(planCard!).getAllByText("写入结果")).toHaveLength(1);
    expect(within(planCard!).getAllByText("归档凭据")).toHaveLength(1);
    expect(screen.queryByText("正在写入核验结果")).toBeNull();
    expect(screen.queryByText("17 张通过，1 张待复核")).toBeNull();
    expect(screen.queryByText("发现一处税号差异")).toBeNull();
    expect(screen.queryByText("钉钉 · 记录核验回执")).toBeNull();
  });

  it("点击历史步骤后在右侧显示结果、过程、依据和交付物，主区不重复", async () => {
    render(<Harness messages={workflowMessages(2)} debugMode />);
    fireEvent.click(screen.getByRole("button", { name: /核验订单/ }));

    await waitFor(() => expect(screen.getByLabelText("步骤详情：核验订单")).toBeTruthy());
    expect(screen.getByText("17 张通过，1 张待复核")).toBeTruthy();
    expect(screen.getByText("核验统计")).toBeTruthy();
    expect(screen.getByText("订单核验结果.xlsx")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "依据" }));
    expect(screen.getByText("receipt:verify-18")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "过程" }));
    const processPanel = document.querySelector<HTMLElement>("[data-business-step-process]");
    expect(processPanel?.childElementCount).toBeGreaterThan(0);
    const planCard = document.querySelector<HTMLElement>("[data-business-step-plan]");
    expect(within(planCard!).getAllByText("核验订单")).toHaveLength(1);
  });

  it("后续精简快照省略旧字段时仍保留历史终态详情", async () => {
    render(<Harness messages={workflowMessages(3)} />);
    fireEvent.click(screen.getByRole("button", { name: /核验订单/ }));

    await waitFor(() => expect(screen.getByLabelText("步骤详情：核验订单")).toBeTruthy());
    expect(screen.getByText("发现一处税号差异")).toBeTruthy();
    expect(screen.getByText("核验统计")).toBeTruthy();
    expect(screen.queryByText("receipt:verify-18")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "依据" }));
    expect(screen.getByText("receipt:verify-18")).toBeTruthy();
  });

  it("waiting 后恢复同一步骤时不把上一终态结果冒充当前结果", async () => {
    const resumedMessages: MessageItem[] = [
      { id: "user-resume", type: "user", content: "继续核验" },
      todoSnapshot("todo-start", [
        { id: "verify", kind: "business", content: "核验订单", activeForm: "正在核验", status: "in_progress" },
      ]),
      todoSnapshot("todo-resume-wait", [
        { id: "verify", kind: "business", content: "核验订单", status: "waiting", outcome: { text: "等待财务确认" } },
      ]),
      todoSnapshot("todo-resume-current", [
        { id: "verify", kind: "business", content: "核验订单", activeForm: "继续核验", status: "in_progress" },
      ]),
    ];

    render(<Harness messages={resumedMessages} />);
    fireEvent.click(screen.getByRole("button", { name: /核验订单/ }));

    await waitFor(() => expect(screen.getByLabelText("步骤详情：核验订单")).toBeTruthy());
    expect(screen.getByText("正在跟随当前步骤")).toBeTruthy();
    expect(screen.queryByText("等待财务确认")).toBeNull();
  });

  it("点击当前步骤默认跟随；快照推进后自动切到新的当前步骤", async () => {
    const { rerender } = render(<Harness messages={workflowMessages(1)} />);
    fireEvent.click(screen.getByRole("button", { name: /核验订单/ }));
    expect(screen.getByText("正在跟随当前步骤")).toBeTruthy();

    rerender(<Harness messages={workflowMessages(2)} />);
    await waitFor(() => expect(screen.getByLabelText("步骤详情：写入结果")).toBeTruthy());
    expect(screen.getByText("正在跟随当前步骤")).toBeTruthy();
  });

  it("用户固定查看历史步骤后，新快照只更新数据，不强制切走", async () => {
    const { rerender } = render(<Harness messages={workflowMessages(2)} />);
    fireEvent.click(screen.getByRole("button", { name: /核验订单/ }));
    expect(screen.getByText("已暂停跟随")).toBeTruthy();

    rerender(<Harness messages={workflowMessages(3)} />);
    await waitFor(() => expect(screen.getByLabelText("步骤详情：核验订单")).toBeTruthy());
    expect(screen.getByRole("button", { name: "返回当前步骤" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回当前步骤" }));
    expect(screen.getByLabelText("步骤详情：归档凭据")).toBeTruthy();
  });

  it("历史前插后只在同一 Run 内重映射，避免复用 todo id 时跨 Run 错选", async () => {
    const current = todoSnapshot("todo-start", [
      { id: "stable-step", kind: "business", content: "稳定步骤（第一轮）", activeForm: "正在处理", status: "in_progress" },
    ], "run-1");
    const earlier = todoSnapshot("todo-earlier", [
      { id: "stable-step", kind: "business", content: "稳定步骤（第一轮）", status: "pending" },
    ], "run-1");
    const secondRun = todoSnapshot("todo-second-run", [
      { id: "stable-step", kind: "business", content: "稳定步骤（第二轮）", activeForm: "正在处理", status: "in_progress" },
    ], "run-2");
    const { rerender } = render(<Harness messages={[current, secondRun]} />);
    fireEvent.click(screen.getByRole("button", { name: /稳定步骤（第一轮）/ }));
    await waitFor(() => expect(screen.getByLabelText("步骤详情：稳定步骤（第一轮）")).toBeTruthy());

    rerender(<Harness messages={[earlier, current, secondRun]} />);

    await waitFor(() => expect(screen.getByLabelText("步骤详情：稳定步骤（第一轮）")).toBeTruthy());
    expect(screen.getByRole("button", { name: /稳定步骤（第一轮）/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByLabelText("步骤详情：稳定步骤（第二轮）")).toBeNull();
  });

  it("无 runId 的旧历史前插仅有唯一候选时保持步骤详情", async () => {
    const current = todoSnapshot("legacy-current", [
      { id: "legacy-step", kind: "business", content: "旧历史稳定步骤", status: "in_progress" },
    ], null);
    const earlier = todoSnapshot("legacy-earlier", [
      { id: "legacy-step", kind: "business", content: "旧历史稳定步骤", status: "pending" },
    ], null);
    const { rerender } = render(<Harness messages={[current]} />);
    fireEvent.click(screen.getByRole("button", { name: /旧历史稳定步骤/ }));
    await waitFor(() => expect(screen.getByLabelText("步骤详情：旧历史稳定步骤")).toBeTruthy());

    rerender(<Harness messages={[earlier, current]} />);

    await waitFor(() => expect(screen.getByLabelText("步骤详情：旧历史稳定步骤")).toBeTruthy());
    expect(screen.getByRole("button", { name: /旧历史稳定步骤/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("无 runId 的旧计划候选不唯一时安全关闭详情", async () => {
    const current = todoSnapshot("legacy-current", [
      { id: "legacy-step", kind: "business", content: "重复旧步骤", status: "in_progress" },
    ], null);
    const earlierFirst = todoSnapshot("legacy-first", [
      { id: "legacy-step", kind: "business", content: "重复旧步骤", status: "pending" },
    ], null);
    const earlierSecond = todoSnapshot("legacy-second", [
      { id: "legacy-step", kind: "business", content: "重复旧步骤", status: "pending" },
    ], null);
    const { rerender } = render(<Harness messages={[current]} />);
    fireEvent.click(screen.getByRole("button", { name: /重复旧步骤/ }));
    await waitFor(() => expect(screen.getByLabelText("步骤详情：重复旧步骤")).toBeTruthy());

    rerender(<Harness messages={[
      earlierFirst,
      { id: "legacy-boundary", type: "user", content: "下一轮" },
      earlierSecond,
      current,
    ]} />);

    await waitFor(() => expect(screen.queryByLabelText("步骤详情：重复旧步骤")).toBeNull());
  });

  it("主卡移出虚拟化窗口后详情继续更新，关闭时焦点回退消息容器", async () => {
    const { rerender } = render(<Harness messages={workflowMessages(2)} />);
    fireEvent.click(screen.getByRole("button", { name: /核验订单/ }));
    await waitFor(() => expect(screen.getByLabelText("步骤详情：核验订单")).toBeTruthy());

    const trailing = Array.from({ length: 180 }, (_, index): MessageItem => ({
      id: `trailing-${index}`,
      type: "user",
      content: `后续消息 ${index}`,
      timestamp: 10_000 + index,
    }));
    rerender(<Harness messages={[...workflowMessages(2), ...trailing]} />);

    await waitFor(() => expect(screen.queryByRole("button", { name: /核验订单/ })).toBeNull());
    expect(screen.getByLabelText("步骤详情：核验订单")).toBeTruthy();
    expect(screen.getByText("17 张通过，1 张待复核")).toBeTruthy();

    const scrollContainer = document.querySelector<HTMLElement>("[data-message-scroll-container]");
    fireEvent.click(screen.getByRole("button", { name: "关闭步骤详情" }));
    await waitFor(() => expect(document.activeElement).toBe(scrollContainer));
  });

  it("切换会话会清理旧选择，关闭后焦点返回触发步骤行", async () => {
    const { rerender } = render(<Harness messages={workflowMessages(2)} sessionId="session-a" />);
    const row = screen.getByRole("button", { name: /核验订单/ });
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByLabelText("步骤详情：核验订单")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "关闭步骤详情" }));
    await waitFor(() => expect(document.activeElement).toBe(row));

    fireEvent.click(row);
    rerender(<Harness messages={workflowMessages(2)} sessionId="session-b" />);
    await waitFor(() => expect(screen.queryByLabelText("步骤详情：核验订单")).toBeNull());
  });

  it("其他显式面板替换步骤详情时不抢回旧步骤焦点", async () => {
    render(<Harness messages={workflowMessages(2)} />);
    fireEvent.click(screen.getByRole("button", { name: /核验订单/ }));
    await waitFor(() => expect(screen.getByLabelText("步骤详情：核验订单")).toBeTruthy());

    const replacementTrigger = screen.getByRole("button", { name: "打开其他面板" });
    replacementTrigger.focus();
    fireEvent.click(replacementTrigger);
    await waitFor(() => expect(screen.queryByLabelText("步骤详情：核验订单")).toBeNull());
    expect(document.activeElement).toBe(replacementTrigger);
  });

  it("同一 Run 跨 user、system_event 与 user-voice 后收齐过程、系统动作与 Artifact", async () => {
    const active = [{ id: "verify", kind: "business", content: "跨消息核验", status: "in_progress" }];
    const messages: MessageItem[] = [
      { id: "continuation-user-1", type: "user", content: "开始核验" },
      todoSnapshot("continuation-plan", active, "run-continuation"),
      {
        id: "continuation-before", type: "tool_use", toolName: "Read", toolId: "continuation-before",
        toolInput: "{}", resultReady: true, executionStatus: "completed",
        presentation: { title: "前半段读取" },
      },
      { id: "continuation-user-2", type: "user", content: "补充条件" },
      todoSnapshot("continuation-resume", active, "run-continuation"),
      {
        id: "continuation-after", type: "tool_use", toolName: "Read", toolId: "continuation-after",
        toolInput: "{}", resultReady: true, executionStatus: "completed",
        presentation: { title: "用户边界后读取" },
      },
      { id: "continuation-system", type: "system_event", title: "系统事件", content: "继续核验" },
      todoSnapshot("continuation-system-resume", active, "run-continuation"),
      {
        id: "continuation-after-system", type: "tool_use", toolName: "Read", toolId: "continuation-after-system",
        toolInput: "{}", resultReady: true, executionStatus: "completed",
        presentation: { title: "系统事件后读取" },
      },
      {
        id: "continuation-voice", type: "user-voice", audioUrl: "voice.wav", duration: 1, status: "sent",
      },
      todoSnapshot("continuation-voice-resume", active, "run-continuation"),
      {
        id: "continuation-after-voice", type: "tool_use", toolName: "Read", toolId: "continuation-after-voice",
        toolInput: "{}", resultReady: true, executionStatus: "completed",
        presentation: { title: "语音边界后读取" },
      },
      {
        id: "continuation-connector", type: "tool_use", toolName: "DwsBusiness", toolId: "continuation-connector",
        toolInput: "{}", resultReady: true, executionStatus: "completed",
        presentation: { title: "钉钉 · 写入核验回执", connector: { system: "钉钉", write: true } },
      },
      {
        id: "continuation-artifact", type: "file_download", fileName: "跨消息核验结果.xlsx",
        filePath: "assets/跨消息核验结果.xlsx", fileType: "xlsx", fileSize: 128,
        artifactId: "artifact-continuation", artifactKind: "file",
      },
      todoSnapshot("continuation-done", [{
        ...active[0], status: "completed", outcome: { text: "跨消息核验完成" },
        evidenceRefs: ["receipt:continuation"],
      }], "run-continuation"),
    ];

    render(<Harness messages={messages} debugMode />);
    expect(screen.queryByText(/前半段读取/)).toBeNull();
    expect(screen.queryByText(/用户边界后读取/)).toBeNull();
    expect(screen.queryByText(/系统事件后读取/)).toBeNull();
    expect(screen.queryByText(/语音边界后读取/)).toBeNull();
    expect(screen.queryByText("跨消息核验结果.xlsx")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /跨消息核验/ }));
    await waitFor(() => expect(screen.getByLabelText("步骤详情：跨消息核验")).toBeTruthy());
    expect(screen.getByText("跨消息核验完成")).toBeTruthy();
    expect(screen.getByText("跨消息核验结果.xlsx")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "过程" }));
    expect(screen.getByText(/前半段读取/)).toBeTruthy();
    expect(screen.getByText(/用户边界后读取/)).toBeTruthy();
    expect(screen.getByText(/系统事件后读取/)).toBeTruthy();
    expect(screen.getByText(/语音边界后读取/)).toBeTruthy();
    expect(document.querySelector("[data-business-step-process]")?.childElementCount).toBeGreaterThanOrEqual(5);
    expect(screen.getByText(/写入核验回执/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "依据" }));
    expect(screen.getByText("receipt:continuation")).toBeTruthy();
  });

  it("步骤中的真实 permission_request 仍留在主对话区域", () => {
    const messages: MessageItem[] = [
      { id: "user-permission", type: "user", content: "执行命令" },
      todoSnapshot("todo-permission", [{ id: "run", kind: "business", content: "执行命令", status: "in_progress" }]),
      {
        id: "permission-1",
        type: "permission_request",
        interactionId: "permission-1",
        toolName: "Shell",
        toolInput: JSON.stringify({ command: "echo ok" }),
        status: "pending",
      },
    ];
    render(<Harness messages={messages} />);
    expect(document.querySelector("[data-business-step-plan]")).toBeTruthy();
    expect(screen.getByText(/Permission: Shell/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });
});
