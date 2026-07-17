import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import { ModelManager } from "./index";

// 平台管理员分层治理（2026-07-18）：组件依赖 useAuth().platformReadOnly，测试无 AuthProvider，mock 为可写态
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ platformReadOnly: false, isSuperAdmin: true, isPlatformAdmin: true }),
}));
vi.mock("@/lib/authFetch", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/refreshBus", () => ({ refreshAll: vi.fn(async () => undefined) }));

const initialModels = {
  default: "main/gpt",
  allowCrossGroupSwitch: true,
  groups: [
    {
      id: "main",
      name: "主分组",
      models: [
        { id: "gpt", name: "GPT", value: "gpt" },
        { id: "mini", name: "Mini", value: "mini" },
      ],
    },
    {
      id: "backup",
      name: "备用分组",
      models: [{ id: "glm", name: "GLM", value: "glm" }],
    },
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ModelManager 排序", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(async (_path, init) => {
      if (init?.method === "PUT") {
        const payload = JSON.parse(String(init.body));
        return jsonResponse({
          ...payload,
          publicModelList: {
            ...payload.models,
            groups: payload.models.groups.map((group: typeof initialModels.groups[number]) => ({
              id: group.id,
              name: group.name,
              models: group.models.map((model) => ({ id: model.id, name: model.name })),
            })),
          },
        });
      }
      return jsonResponse({
        models: initialModels,
        memoryIndex: null,
        publicModelList: initialModels,
      });
    });
  });

  it("将分组与组内模型的新顺序保存为平台全局顺序", async () => {
    const user = userEvent.setup();
    render(<ModelManager />);

    expect(await screen.findByText("模型分组")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "调整分组 备用分组 的顺序" }), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("button", { name: "调整模型 Mini 的顺序" }), { key: "ArrowUp" });
    await user.click(screen.getByRole("button", { name: "保存并生效" }));

    await waitFor(() => {
      expect(vi.mocked(authFetch).mock.calls.some((call) => call[1]?.method === "PUT")).toBe(true);
    });
    const putCall = vi.mocked(authFetch).mock.calls.find((call) => call[1]?.method === "PUT");
    const payload = JSON.parse(String(putCall?.[1]?.body));
    expect(payload.models.groups.map((group: { id: string }) => group.id)).toEqual(["backup", "main"]);
    expect(payload.models.groups[1].models.map((model: { id: string }) => model.id)).toEqual(["mini", "gpt"]);
  });
});
