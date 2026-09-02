import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatInput } from "./ChatInput";

const voiceRecorderState = vi.hoisted(() => ({ isSupported: false }));

vi.mock("@/hooks/useVoiceRecorder", () => ({
  useVoiceRecorder: () => ({
    isRecording: false,
    isSupported: voiceRecorderState.isSupported,
    duration: 0,
    ensurePermission: vi.fn(),
    startRecording: vi.fn(),
    stopAndSend: vi.fn(),
    cancelRecording: vi.fn(),
  }),
}));

function renderInput(overrides: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
  const onFileSelect = vi.fn();
  render(
    <ChatInput
      input=""
      uploading={false}
      hasUploadedFiles={false}
      onInputChange={vi.fn()}
      onSend={vi.fn()}
      onFileSelect={onFileSelect}
      {...overrides}
    />,
  );
  return { onFileSelect };
}

beforeEach(() => {
  voiceRecorderState.isSupported = false;
});

describe("ChatInput 布局", () => {
  it("将附着内容渲染在输入框前，并让输入框覆盖交界边框", () => {
    renderInput({ attachedTopSlot: <div data-testid="attached-top-slot">任务清单</div> });

    const attachedSlot = screen.getByTestId("attached-top-slot");
    const inputCard = screen.getByPlaceholderText("输入消息...").parentElement;

    expect(attachedSlot.compareDocumentPosition(inputCard as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(inputCard?.classList.contains("z-10")).toBe(true);
  });

  it("为输入文字保留更舒展的上下间距", () => {
    renderInput();

    const textarea = screen.getByPlaceholderText("输入消息...");
    expect(textarea.classList.contains("pt-3.5")).toBe(true);
    expect(textarea.classList.contains("pb-2")).toBe(true);
    expect(textarea.style.minHeight).toBe("56px");
  });

  it("空输入时保留禁用的发送按钮", () => {
    renderInput();

    expect((screen.getByRole("button", { name: "发送消息" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Web 不新增录音，即使浏览器支持麦克风也只显示发送按钮", () => {
    voiceRecorderState.isSupported = true;
    renderInput({ onSendVoice: vi.fn() });

    expect(screen.queryByRole("button", { name: "语音输入" })).toBeNull();
    expect((screen.getByRole("button", { name: "发送消息" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("输入消息后启用发送按钮", () => {
    renderInput({ input: "测试消息" });

    expect((screen.getByRole("button", { name: "发送消息" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("运行中默认加入队列，并把立即插话作为独立显式操作", () => {
    const onSend = vi.fn();
    const onInterject = vi.fn();
    renderInput({ input: "下一项任务", loading: true, onSend, onInterject });

    fireEvent.click(screen.getByRole("button", { name: "加入队列" }));
    expect(onSend).toHaveBeenCalledOnce();
    expect(onInterject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "立即插话" }));
    expect(onInterject).toHaveBeenCalledOnce();
  });
});

describe("ChatInput 沙箱档位", () => {
  it("默认只展示当前档位，点击后展开单选菜单", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderInput({ sandboxProfile: "daily", onSandboxProfileChange: onChange });

    const trigger = screen.getByRole("button", { name: "运行环境：日常" });
    expect(screen.queryByRole("radio", { name: /编程/ })).toBeNull();

    await user.click(trigger);

    expect(screen.getByRole("radio", { name: "日常" }).getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("radio", { name: "编程" }));
    expect(onChange).toHaveBeenLastCalledWith("coding");
  });

  it("已有会话按给定档位展示且禁止原地切换", () => {
    const onChange = vi.fn();
    renderInput({ sessionId: "session-1", sandboxProfile: "coding", onSandboxProfileChange: onChange });

    const trigger = screen.getByRole("button", { name: "运行环境：编程" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("首条消息发送期间锁定档位，等待服务端确认会话", () => {
    const onChange = vi.fn();
    renderInput({ loading: true, sandboxProfile: "daily", onSandboxProfileChange: onChange });

    const trigger = screen.getByRole("button", { name: "运行环境：日常" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ChatInput 附件来源入口", () => {
  it("首次点击立即显示更舒展的本地和云端文件选项", () => {
    renderInput({ onAssetSelect: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: "添加附件" }));

    const localOption = screen.getByRole("button", { name: "本地文件" });
    expect(localOption.classList.contains("text-[13px]")).toBe(true);
    expect(localOption.classList.contains("py-2")).toBe(true);
    expect(screen.getByRole("button", { name: "云端文件" })).toBeTruthy();
    expect(screen.queryByText("从设备中选择")).toBeNull();
    expect(screen.queryByText("选择已有文件")).toBeNull();
  });

  it("选择资料库后打开 assets 选择弹窗", async () => {
    renderInput({ onAssetSelect: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
    fireEvent.click(await screen.findByRole("button", { name: "云端文件" }));

    expect(await screen.findByText("从资料库添加")).toBeTruthy();
  });

  it("选择本地文件后仍走既有上传回调", async () => {
    const { onFileSelect } = renderInput({ onAssetSelect: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
    fireEvent.click(await screen.findByRole("button", { name: "本地文件" }));

    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();
    const file = new File(["hello"], "手机文件.txt", { type: "text/plain" });
    fireEvent.change(fileInput!, { target: { files: [file] } });

    expect(onFileSelect).toHaveBeenCalledTimes(1);
  });

  it("上传中禁用附件入口，避免重复选择", () => {
    renderInput({ uploading: true, onAssetSelect: vi.fn() });

    expect((screen.getByRole("button", { name: "添加附件" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
