/**
 * 应用内确认对话框的行为契约测试。
 *
 * 为什么必须测：它替换了 8 处 `window.confirm` + 2 处 `window.prompt`，其中包括
 * 「永久删除 workspace 目录」这类不可恢复操作。换 UI **绝不能降低确认强度**——
 * 原来是「confirm 弹窗 + prompt 手打目录名」两道，现在必须仍然要求逐字输入。
 * 这层一旦回归，删除操作会退化成一次点击。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { useConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";

function Harness({ request }: { request: Omit<ConfirmRequest, "onConfirm"> & { onConfirm: () => void } }) {
  const { confirm, confirmDialog } = useConfirmDialog();
  return (
    <>
      <button type="button" onClick={() => confirm(request)}>触发</button>
      {confirmDialog}
    </>
  );
}

async function open(request: Omit<ConfirmRequest, "onConfirm"> & { onConfirm: () => void }) {
  const user = userEvent.setup();
  render(<Harness request={request} />);
  await user.click(screen.getByRole("button", { name: "触发" }));
  return user;
}

describe("useConfirmDialog", () => {
  it("普通确认：点确认即执行回调", async () => {
    const onConfirm = vi.fn();
    const user = await open({ title: "暂停执行环境？", onConfirm });

    expect(screen.getByText("暂停执行环境？")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "确认" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("取消不执行回调", async () => {
    const onConfirm = vi.fn();
    const user = await open({ title: "暂停执行环境？", onConfirm });

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("requireText：未输入时确认按钮禁用，回调不可能被触发", async () => {
    const onConfirm = vi.fn();
    const user = await open({ title: "永久删除目录？", requireText: "ws-abc123", tone: "danger", onConfirm });

    const confirmButton = screen.getByRole("button", { name: "确认" });
    expect(confirmButton.hasAttribute("disabled")).toBe(true);

    await user.click(confirmButton);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("requireText：输错一个字符也不放行", async () => {
    const onConfirm = vi.fn();
    const user = await open({ title: "永久删除目录？", requireText: "ws-abc123", onConfirm });

    await user.type(screen.getByPlaceholderText("ws-abc123"), "ws-abc12");
    expect(screen.getByRole("button", { name: "确认" }).hasAttribute("disabled")).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("requireText：逐字输对后才放行", async () => {
    const onConfirm = vi.fn();
    const user = await open({ title: "永久删除目录？", requireText: "ws-abc123", onConfirm });

    await user.type(screen.getByPlaceholderText("ws-abc123"), "ws-abc123");
    const confirmButton = screen.getByRole("button", { name: "确认" });
    expect(confirmButton.hasAttribute("disabled")).toBe(false);

    await user.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("requireText：输入框内按 Enter 等价于确认，但仍受文本校验约束", async () => {
    const onConfirm = vi.fn();
    const user = await open({ title: "永久删除目录？", requireText: "ws-abc123", onConfirm });
    const input = screen.getByPlaceholderText("ws-abc123");

    // 文本不对时 Enter 无效
    await user.type(input, "wrong{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "ws-abc123{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("重新打开时清空上次输入，不残留已通过的校验", async () => {
    const onConfirm = vi.fn();
    const user = await open({ title: "永久删除目录？", requireText: "ws-abc123", onConfirm });

    await user.type(screen.getByPlaceholderText("ws-abc123"), "ws-abc123");
    await user.click(screen.getByRole("button", { name: "取消" }));

    await user.click(screen.getByRole("button", { name: "触发" }));
    // 关键：不能因为上次输对过就直接可确认
    expect(screen.getByRole("button", { name: "确认" }).hasAttribute("disabled")).toBe(true);
    expect((screen.getByPlaceholderText("ws-abc123") as HTMLInputElement).value).toBe("");
  });

  it("影响面清单逐条渲染（原生 confirm 只能塞 \\n）", async () => {
    await open({
      title: "永久删除目录？",
      details: [
        { label: "大小", value: "1.2 GB" },
        { label: "文件数", value: "3,481" },
      ],
      onConfirm: vi.fn(),
    });

    expect(screen.getByText("大小")).toBeTruthy();
    expect(screen.getByText("1.2 GB")).toBeTruthy();
    expect(screen.getByText("文件数")).toBeTruthy();
    expect(screen.getByText("3,481")).toBeTruthy();
  });

  it("danger 语气用 destructive 按钮，与例行操作在视觉上可区分", async () => {
    await open({ title: "永久删除目录？", tone: "danger", confirmLabel: "永久删除", onConfirm: vi.fn() });
    const button = screen.getByRole("button", { name: "永久删除" });
    expect(button.className).toContain("destructive");
  });

  it("自定义按钮文案生效", async () => {
    await open({ title: "归档目录？", confirmLabel: "归档", cancelLabel: "先不动", onConfirm: vi.fn() });
    expect(screen.getByRole("button", { name: "归档" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "先不动" })).toBeTruthy();
  });

  it("确认后对话框关闭", async () => {
    const user = await open({ title: "暂停执行环境？", onConfirm: vi.fn() });
    await user.click(screen.getByRole("button", { name: "确认" }));
    expect(screen.queryByText("暂停执行环境？")).toBeNull();
  });
});
