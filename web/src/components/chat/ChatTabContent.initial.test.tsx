import { createRef, type ComponentProps, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ChatTabContent } from "./ChatTabContent";

vi.mock("@/components/AgentAvatar", () => ({
  AgentAvatar: () => <span data-testid="personal-avatar" />,
}));

vi.mock("@/components/OrgAgentAvatar", () => ({
  OrgAgentAvatarContent: () => <span data-testid="expert-avatar" />,
}));

vi.mock("@/components/MessageList", () => ({
  MessageList: ({ messages, emptySlot }: { messages: unknown[]; emptySlot?: ReactNode }) => (
    <div data-testid="message-list" data-message-count={messages.length}>{emptySlot}</div>
  ),
}));

vi.mock("@/components/FileUpload", () => ({
  FileUpload: ({ uploadedFiles }: { uploadedFiles: unknown[] }) => (
    <div data-testid="file-upload" data-file-count={uploadedFiles.length} />
  ),
}));

vi.mock("@/components/ChatInput", () => ({
  ChatInput: ({
    input,
    onInputChange,
    placeholder = "输入消息...",
    topSlot,
  }: {
    input: string;
    onInputChange: (value: string) => void;
    placeholder?: string;
    topSlot?: ReactNode;
  }) => (
    <div data-testid="chat-input">
      {topSlot}
      <textarea
        aria-label="composer"
        value={input}
        placeholder={placeholder}
        onChange={(event) => onInputChange(event.target.value)}
      />
    </div>
  ),
}));

vi.mock("@/components/AskUserPromptPanel", () => ({
  AskUserPromptPanel: () => <div data-testid="ask-user-panel" />,
}));

vi.mock("@/components/QueuedMessageBar", () => ({
  QueuedMessageBar: () => <div data-testid="queued-message-bar" />,
}));

type Props = ComponentProps<typeof ChatTabContent>;

const expert = {
  id: "expert-ops",
  name: "经营分析专家",
  description: "负责经营分析",
  starterPrompts: ["复盘本月经营数据"],
  skillCount: 2,
};

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    messages: [],
    loading: false,
    isLoadingMessages: false,
    lastMessageRef: createRef<HTMLDivElement>(),
    scrollContainerRef: createRef<HTMLDivElement>(),
    uploadedFiles: [],
    onRemoveFile: vi.fn(),
    input: "",
    uploading: false,
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onFileSelect: vi.fn(),
    initialComposer: true,
    emptySlot: <div>推荐任务</div>,
    agentProfile: {
      username: "personal-agent",
      name: "麦迪文",
      updatedAt: "",
      updatedBy: "user",
    },
    ...overrides,
  };
}

describe("ChatTabContent 初始会话", () => {
  it("个人 Agent 居中展示身份、邀请语和推荐", () => {
    render(<ChatTabContent {...makeProps()} />);

    expect(screen.getByText("麦迪文")).toBeTruthy();
    expect(screen.getByText("今天先推进哪件事？")).toBeTruthy();
    expect(screen.queryByText("直接描述目标，或从一个开箱任务开始。")).toBeNull();
    expect(screen.getByPlaceholderText("说清目标，我来拆解并推进")).toBeTruthy();
    expect(screen.getByText("推荐任务").closest("[aria-hidden]")?.getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByTestId("chat-input").closest("[data-initial-conversation]")?.getAttribute("data-initial-conversation")).toBe("true");
    const initialStage = screen.getByTestId("chat-input").parentElement?.parentElement;
    expect(initialStage?.className).toContain("overflow-y-auto");
    expect(initialStage?.className).not.toContain("shrink-0");
  });

  it("草稿或附件出现后推荐退场，但仍保持初始 composer", () => {
    const view = render(<ChatTabContent {...makeProps({ input: "准备一份经营复盘" })} />);

    expect(screen.queryByText("推荐任务")).toBeNull();
    expect(document.querySelector("[data-initial-suggestions='hidden']")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("chat-input").closest("[data-initial-conversation]")?.getAttribute("data-initial-conversation")).toBe("true");

    view.rerender(<ChatTabContent {...makeProps({ uploadedFiles: [{ originalName: "经营数据.xlsx" } as never] })} />);
    expect(screen.getByTestId("file-upload").getAttribute("data-file-count")).toBe("1");
    expect(screen.queryByText("推荐任务")).toBeNull();
  });

  it("推荐退场后从 DOM 与 Tab 顺序移除且无法用 Enter 触发", async () => {
    const onTryRecommendation = vi.fn();
    const user = userEvent.setup();
    const emptySlot = <button type="button" onClick={onTryRecommendation}>隐藏推荐</button>;
    const view = render(<ChatTabContent {...makeProps({ emptySlot })} />);
    const textarea = screen.getByLabelText("composer");
    const recommendation = screen.getByRole("button", { name: "隐藏推荐" });

    view.rerender(<ChatTabContent {...makeProps({ input: "已有草稿", emptySlot })} />);

    expect(screen.queryByRole("button", { name: "隐藏推荐" })).toBeNull();
    expect(document.contains(recommendation)).toBe(false);
    expect(screen.getByLabelText("composer")).toBe(textarea);
    textarea.focus();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(onTryRecommendation).not.toHaveBeenCalled();
  });

  it("首条消息出现后丝滑切回消息流且不重挂载 textarea", () => {
    const view = render(<ChatTabContent {...makeProps()} />);
    const initialTextarea = screen.getByLabelText("composer");

    view.rerender(<ChatTabContent {...makeProps({
      messages: [{ id: "user-1", type: "user", content: "开始复盘" }],
      input: "",
    })} />);

    expect(screen.getByLabelText("composer")).toBe(initialTextarea);
    expect(screen.getByTestId("chat-input").closest("[data-initial-conversation]")?.getAttribute("data-initial-conversation")).toBe("false");
    expect(screen.getByTestId("message-list").getAttribute("data-message-count")).toBe("1");
    expect(screen.getByPlaceholderText("输入消息...")).toBeTruthy();
  });

  it("企业专家复用同一骨架，初始态不重复显示 composer 标签", () => {
    const view = render(<ChatTabContent {...makeProps({ orgAgent: expert })} />);

    expect(screen.getByText("要让经营分析专家处理什么？")).toBeTruthy();
    expect(screen.getByPlaceholderText("交代目标、范围和希望经营分析专家交付的结果")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "使用经营分析专家发起新对话" })).toBeNull();

    view.rerender(<ChatTabContent {...makeProps({
      orgAgent: expert,
      messages: [{ id: "user-1", type: "user", content: "开始" }],
      onNewOrgAgentConversation: vi.fn(),
    })} />);
    expect(screen.getByRole("button", { name: "使用经营分析专家发起新对话" })).toBeTruthy();
  });

  it("AskUser 或排队交互存在时不误判为空会话", () => {
    const askUser = {
      id: "ask-1",
      type: "ask_user" as const,
      interactionId: "interaction-1",
      status: "pending" as const,
      questions: [{
        question: "请选择范围",
        header: "范围",
        options: [{ label: "全部", description: "全部数据" }, { label: "本月", description: "本月数据" }],
        multiSelect: false,
      }],
    };
    const view = render(<ChatTabContent {...makeProps({ messages: [askUser] })} />);

    expect(screen.getByTestId("chat-input").closest("[data-initial-conversation]")?.getAttribute("data-initial-conversation")).toBe("false");
    expect(screen.getByTestId("ask-user-panel")).toBeTruthy();

    view.rerender(<ChatTabContent {...makeProps({
      queuedInterjections: [{ clientMsgId: "queued-1" } as never],
      onCancelQueuedInterjection: vi.fn(),
      onEditQueuedInterjection: vi.fn(),
      onResendQueuedInterjection: vi.fn(),
      onDismissQueuedInterjection: vi.fn(),
    })} />);
    expect(screen.getByTestId("chat-input").closest("[data-initial-conversation]")?.getAttribute("data-initial-conversation")).toBe("false");
    expect(screen.getByTestId("queued-message-bar")).toBeTruthy();
  });

  it("会话加载失败时退出初始态并提供原位重试", () => {
    const onRetrySessionLoad = vi.fn();
    const view = render(<ChatTabContent {...makeProps({
      sessionLoadError: "会话加载超时，请重试",
      onRetrySessionLoad,
    })} />);

    expect(screen.getByRole("alert").textContent).toContain("无需刷新页面");
    expect(screen.getByTestId("chat-input").closest("[data-initial-conversation]")?.getAttribute("data-initial-conversation")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(onRetrySessionLoad).toHaveBeenCalledTimes(1);

    view.rerender(<ChatTabContent {...makeProps({
      messages: [{ id: "cached-1", type: "user", content: "缓存消息" }],
      sessionLoadError: "会话加载超时，请重试",
      onRetrySessionLoad,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetrySessionLoad).toHaveBeenCalledTimes(2);
  });

  it("初始 placeholder 仍可正常驱动受控输入", () => {
    const onInputChange = vi.fn();
    render(<ChatTabContent {...makeProps({ onInputChange })} />);

    fireEvent.change(screen.getByLabelText("composer"), { target: { value: "新的目标" } });
    expect(onInputChange).toHaveBeenCalledWith("新的目标");
  });
});
