import { fireEvent, render, screen } from "@testing-library/react";
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

  it("支持语音时分别显示麦克风和发送按钮", () => {
    voiceRecorderState.isSupported = true;
    renderInput({ onSendVoice: vi.fn() });

    expect(screen.getByRole("button", { name: "语音输入" })).toBeTruthy();
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

describe("ChatInput 附件来源入口", () => {
  it("点击添加附件后先显示本地文件和资料库选项", () => {
    renderInput({ onAssetSelect: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: "添加附件" }));

    expect(screen.getByRole("button", { name: "本地文件" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "资料库" })).toBeTruthy();
  });

  it("选择本地文件后仍走既有上传回调", () => {
    const { onFileSelect } = renderInput({ onAssetSelect: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
    fireEvent.click(screen.getByRole("button", { name: "本地文件" }));

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
