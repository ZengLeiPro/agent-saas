import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatInput } from "./ChatInput";

const authFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/authFetch", () => ({
  authFetch: authFetchMock,
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
}: {
  sessionId: string;
  onSend?: () => void;
}) {
  const [input, setInput] = useState("");
  return (
    <ChatInput
      input={input}
      sessionId={sessionId}
      uploading={false}
      hasUploadedFiles={false}
      onInputChange={setInput}
      onSend={onSend}
      onFileSelect={vi.fn()}
    />
  );
}

beforeEach(() => {
  authFetchMock.mockReset();
  authFetchMock.mockResolvedValue(new Response(null, { status: 202 }));
});

describe("ChatInput Sandbox 预热", () => {
  it("聚焦、空白输入和光标移动都不触发", async () => {
    const user = userEvent.setup();
    render(<ControlledInput sessionId="warmup-focus" />);
    const textarea = screen.getByPlaceholderText("输入消息...");

    await user.click(textarea);
    await user.type(textarea, "  ");
    fireEvent.keyDown(textarea, { key: "ArrowLeft" });

    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("第一次有效输入触发一次，连续输入不重复", async () => {
    const user = userEvent.setup();
    render(<ControlledInput sessionId="warmup-typing" />);
    const textarea = screen.getByPlaceholderText("输入消息...");

    await user.type(textarea, "abc");

    expect(authFetchMock).toHaveBeenCalledOnce();
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/sessions/warmup-typing/warmup",
      { method: "POST" },
    );
    expect((textarea as HTMLTextAreaElement).value).toBe("abc");
  });

  it("中文 IME composition 结束后只触发一次且不破坏输入", async () => {
    render(<ControlledInput sessionId="warmup-ime" />);
    const textarea = screen.getByPlaceholderText("输入消息...");

    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, { target: { value: "中" } });
    expect(authFetchMock).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea, { data: "中" });
    fireEvent.change(textarea, { target: { value: "中文" } });

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledOnce());
    expect((textarea as HTMLTextAreaElement).value).toBe("中文");
  });

  it("粘贴有效文本可以触发", async () => {
    const user = userEvent.setup();
    render(<ControlledInput sessionId="warmup-paste" />);
    const textarea = screen.getByPlaceholderText("输入消息...");

    await user.click(textarea);
    await user.paste("粘贴内容");

    expect(authFetchMock).toHaveBeenCalledOnce();
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

    expect(authFetchMock).toHaveBeenCalledTimes(2);
    expect(authFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/sessions/warmup-switch-a/warmup",
      "/api/sessions/warmup-switch-b/warmup",
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
      target: { value: "第二次" },
    });

    expect(authFetchMock).toHaveBeenCalledOnce();
  });

  it("warmup API 失败不影响输入和消息发送", async () => {
    authFetchMock.mockRejectedValueOnce(new Error("network down"));
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
