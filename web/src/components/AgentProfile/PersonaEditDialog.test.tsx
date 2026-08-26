import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchPersona: vi.fn(),
  updatePersona: vi.fn(),
}));

vi.mock("@agent/shared", () => ({
  fetchPersona: api.fetchPersona,
  parsePersona: (value: string) => ({ body: value }),
  updatePersona: api.updatePersona,
}));

import { PersonaEditDialog } from "./PersonaEditDialog";

describe("PersonaEditDialog", () => {
  beforeEach(() => {
    api.fetchPersona.mockReset();
    api.updatePersona.mockReset();
    api.fetchPersona.mockResolvedValue("已有的人格定义");
    api.updatePersona.mockResolvedValue(undefined);
  });

  it("读取失败时禁止保存空内容，并允许重新加载", async () => {
    api.fetchPersona.mockRejectedValueOnce(new Error("人格定义读取失败"));
    render(<PersonaEditDialog username="tester" open onOpenChange={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toContain("人格定义读取失败");
    const saveButton = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    await userEvent.click(saveButton);
    expect(api.updatePersona).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "重新加载" }));
    const editor = await screen.findByRole("textbox", { name: "人格定义内容" });
    expect((editor as HTMLTextAreaElement).value).toBe("已有的人格定义");
    expect(saveButton.disabled).toBe(false);
  });

  it("每次打开都以可编辑的大尺寸弹窗加载已有定义", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <PersonaEditDialog username="tester" open onOpenChange={onOpenChange} />,
    );

    const editor = await screen.findByRole("textbox", { name: "人格定义内容" });
    expect((editor as HTMLTextAreaElement).value).toBe("已有的人格定义");
    expect(screen.getByText("编辑人格定义")).toBeTruthy();

    await userEvent.clear(editor);
    await userEvent.type(editor, "可再次编辑的人格定义");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(api.updatePersona).toHaveBeenCalledWith("tester", "可再次编辑的人格定义");
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(<PersonaEditDialog username="tester" open={false} onOpenChange={onOpenChange} />);
    rerender(<PersonaEditDialog username="tester" open onOpenChange={onOpenChange} />);
    await waitFor(() => expect(api.fetchPersona).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole("textbox", { name: "人格定义内容" }) as HTMLTextAreaElement).value).toBe("已有的人格定义");
  });
});
