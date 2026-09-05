import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatInput } from "./ChatInput";

// warmupSessionSandbox 的 URL / method / 转义由 shared sandboxWarmupApi.test.ts 守卫；
// 这里只关心 ChatInput 的触发时机（每会话首次有效输入一次）。
const warmupMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/sessionsApi", () => ({
  warmupSessionSandbox: warmupMock,
}));

vi.mock("@/hooks/useVoiceRecorder", () => ({
  useVoiceRecorder: () => ({
    isRecording: false,
    isSupported: false,
    duration: 0,
    ensurePermission: vi.fn(),
    startRecording: vi.fn(),
    stopAndSend: vi.fn(),
    cancelRecording: vi.fn(),
  }),
}));

function ControlledInput({
  sessionId,
  onSend = vi.fn(),
  placeholder,
  initialInput = "",
}: {
  sessionId: string;
  onSend?: () => void;
  placeholder?: string;
  initialInput?: string;
}) {
  const [input, setInput] = useState(initialInput);
  return (
    <ChatInput
      input={input}
      sessionId={sessionId}
      uploading={false}
      hasUploadedFiles={false}
      onInputChange={setInput}
      onSend={onSend}
      onFileSelect={vi.fn()}
      placeholder={placeholder}
    />
  );
}

beforeEach(() => {
  warmupMock.mockReset();
  warmupMock.mockResolvedValue(undefined);
});

describe("ChatInput Sandbox 预热", () => {
  it("支持初始会话传入邀请式 placeholder", () => {
    render(<ControlledInput sessionId="custom-placeholder" placeholder="说清目标，我来拆解并推进" />);
    expect(screen.getByPlaceholderText("说清目标，我来拆解并推进")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "消息输入" })).toBeTruthy();
  });

  it("聚焦、空白输入和光标移动都不触发", async () => {
    const user = userEvent.setup();
    render(<ControlledInput sessionId="warmup-focus" />);
    const textarea = screen.getByPlaceholderText("输入消息...");

    await user.click(textarea);
    await user.type(textarea, "  ");
    fireEvent.keyDown(textarea, { key: "ArrowLeft" });

    expect(warmupMock).not.toHaveBeenCalled();
  });

  it("第一次有效输入触发一次，连续输入不重复", async () => {
    const user = userEvent.setup();
    render(<ControlledInput sessionId="warmup-typing" />);
    const textarea = screen.getByPlaceholderText("输入消息...");

    await user.type(textarea, "abc");

    expect(warmupMock).toHaveBeenCalledOnce();
    expect(warmupMock).toHaveBeenCalledWith("warmup-typing");
    expect((textarea as HTMLTextAreaElement).value).toBe("abc");
  });

  it("输入清空后，下一轮有效输入可以再次触发", () => {
    render(<ControlledInput sessionId="warmup-next-round" />);
    const textarea = screen.getByPlaceholderText("输入消息...");

    fireEvent.change(textarea, { target: { value: "第一轮" } });
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.change(textarea, { target: { value: "第二轮" } });

    expect(warmupMock).toHaveBeenCalledTimes(2);
    expect(warmupMock).toHaveBeenNthCalledWith(2, "warmup-next-round");
  });

  it("已有草稿继续输入不会冒充空白到有效文本的首字变化", () => {
    render(<ControlledInput sessionId="warmup-existing-draft" initialInput="已有草稿" />);
    const textarea = screen.getByPlaceholderText("输入消息...");

    fireEvent.change(textarea, { target: { value: "已有草稿继续" } });

    expect(warmupMock).not.toHaveBeenCalled();
    expect((textarea as HTMLTextAreaElement).value).toBe("已有草稿继续");
  });

  it("中文 IME composition 结束后只触发一次且不破坏输入", async () => {
    render(<ControlledInput sessionId="warmup-ime" />);
    const textarea = screen.getByPlaceholderText("输入消息...");

    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, { target: { value: "中" } });
    expect(warmupMock).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea, { data: "中" });
    fireEvent.change(textarea, { target: { value: "中文" } });

    await waitFor(() => expect(warmupMock).toHaveBeenCalledOnce());
    expect((textarea as HTMLTextAreaElement).value).toBe("中文");
  });

  it("IME 结束回调晚于会话切换时不会覆盖新 session 的预热状态", async () => {
    const view = render(<ControlledInput sessionId="warmup-ime-old" />);
    const oldTextarea = screen.getByPlaceholderText("输入消息...");

    fireEvent.compositionStart(oldTextarea);
    fireEvent.change(oldTextarea, { target: { value: "旧" } });
    fireEvent.compositionEnd(oldTextarea, { data: "旧" });
    view.rerender(<ControlledInput sessionId="warmup-ime-new" />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.change(screen.getByPlaceholderText("输入消息..."), { target: { value: "新" } });

    expect(warmupMock).toHaveBeenCalledOnce();
    expect(warmupMock).toHaveBeenCalledWith("warmup-ime-new");
  });

  it("粘贴有效文本可以触发", async () => {
    const user = userEvent.setup();
    render(<ControlledInput sessionId="warmup-paste" />);
    const textarea = screen.getByPlaceholderText("输入消息...");

    await user.click(textarea);
    await user.paste("粘贴内容");

    expect(warmupMock).toHaveBeenCalledOnce();
    expect((textarea as HTMLTextAreaElement).value).toBe("粘贴内容");
  });

  it("切换会话后可为新 session 各触发一次", () => {
    const view = render(<ControlledInput sessionId="warmup-switch-a" />);
    fireEvent.change(screen.getByPlaceholderText("输入消息..."), {
      target: { value: "A" },
    });

    view.rerender(<ControlledInput sessionId="warmup-switch-b" />);
    fireEvent.change(screen.getByPlaceholderText("输入消息..."), {
      target: { value: "B" },
    });

    expect(warmupMock).toHaveBeenCalledTimes(2);
    expect(warmupMock.mock.calls.map(([id]) => id)).toEqual([
      "warmup-switch-a",
      "warmup-switch-b",
    ]);
  });

  it("组件重挂载不会让同一 session 形成请求风暴", () => {
    const first = render(<ControlledInput sessionId="warmup-remount" />);
    fireEvent.change(screen.getByPlaceholderText("输入消息..."), {
      target: { value: "第一次" },
    });
    first.unmount();

    render(<ControlledInput sessionId="warmup-remount" />);
    fireEvent.change(screen.getByPlaceholderText("输入消息..."), {
      target: { value: "   " },
    });
    fireEvent.change(screen.getByPlaceholderText("输入消息..."), {
      target: { value: "第二次" },
    });

    expect(warmupMock).toHaveBeenCalledOnce();
  });

  it("warmup API 失败不影响输入和消息发送", async () => {
    warmupMock.mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ControlledInput sessionId="warmup-failure" onSend={onSend} />);
    const textarea = screen.getByPlaceholderText("输入消息...");

    await user.type(textarea, "立即发送");
    expect((textarea as HTMLTextAreaElement).value).toBe("立即发送");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(onSend).toHaveBeenCalledOnce();
  });
});
