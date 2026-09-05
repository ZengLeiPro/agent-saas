import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DeleteSessionDialog } from "./DeleteSessionDialog";

it("等待删除回执时显示进度并阻止重复确认，失败返回后可重试", async () => {
  let finish!: () => void;
  const onConfirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<DeleteSessionDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />);
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  expect((screen.getByRole("button", { name: "删除中…" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
  expect(onConfirm).toHaveBeenCalledOnce();
  await act(async () => { finish(); });
  expect((screen.getByRole("button", { name: "删除" }) as HTMLButtonElement).disabled).toBe(false);
});
