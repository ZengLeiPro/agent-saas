import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import { SystemPromptsManager } from "./index";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ platformReadOnly: false, isSuperAdmin: true, isPlatformAdmin: true }),
}));
vi.mock("@/lib/authFetch", () => ({ authFetch: vi.fn() }));

const DEFAULT_CONTENT = "系统默认提示语";
const CUSTOM_CONTENT = "自定义提示语";

function response(content = DEFAULT_CONTENT, overridden = false): Response {
  return new Response(JSON.stringify({
    prompts: [{
      id: "main.static",
      category: "main",
      label: "主 Agent · 平台静态规则",
      description: "平台规则",
      variables: [],
      defaultContent: DEFAULT_CONTENT,
      content,
      overridden,
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("SystemPromptsManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(async (_path, init) => {
      if (init?.method === "PUT") return response(CUSTOM_CONTENT, true);
      if (init?.method === "DELETE") return response();
      return response();
    });
  });

  it("编辑后保存覆盖，并可恢复系统默认", async () => {
    const user = userEvent.setup();
    render(<SystemPromptsManager />);

    const editor = await screen.findByLabelText("主 Agent · 平台静态规则内容");
    await user.clear(editor);
    await user.type(editor, CUSTOM_CONTENT);
    await user.click(screen.getByRole("button", { name: "保存并热更新" }));

    expect(await screen.findByText("已保存并热更新，后续模型调用立即使用新版本")).toBeTruthy();
    const put = vi.mocked(authFetch).mock.calls.find((call) => call[1]?.method === "PUT");
    expect(put?.[0]).toBe("/api/admin/system-prompts/main.static");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ content: CUSTOM_CONTENT });

    await user.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(await screen.findByText("已恢复系统默认并热更新")).toBeTruthy();
    const reset = vi.mocked(authFetch).mock.calls.find((call) => call[1]?.method === "DELETE");
    expect(reset?.[0]).toBe("/api/admin/system-prompts/main.static");
  });
});
