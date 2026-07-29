import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatInput } from "./ChatInput";

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

describe("ChatInput 移动端附件入口", () => {
  it("由真实 file input 直接承接点击，且不会冒泡触发 textarea 抢焦点", () => {
    renderInput();
    const fileInput = screen.getByLabelText("添加附件") as HTMLInputElement;
    const textarea = screen.getByPlaceholderText("输入消息...");
    const focus = vi.spyOn(textarea, "focus");

    expect(fileInput.type).toBe("file");
    expect(fileInput.classList.contains("opacity-0")).toBe(true);
    expect(fileInput.style.display).not.toBe("none");

    fireEvent.click(fileInput);

    expect(focus).not.toHaveBeenCalled();
  });

  it("手机文件选择器返回文件后仍走既有上传回调", () => {
    const { onFileSelect } = renderInput();
    const fileInput = screen.getByLabelText("添加附件");
    const file = new File(["hello"], "手机文件.txt", { type: "text/plain" });

    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(onFileSelect).toHaveBeenCalledTimes(1);
  });

  it("上传中禁用附件入口，避免移动端重复选择", () => {
    renderInput({ uploading: true });

    expect((screen.getByLabelText("添加附件") as HTMLInputElement).disabled).toBe(true);
  });
});
