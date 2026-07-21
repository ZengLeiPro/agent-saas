import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import { AgentRuntimeProfilesManager } from "./index";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ platformReadOnly: false, isSuperAdmin: true, isPlatformAdmin: true }),
}));
vi.mock("@/lib/authFetch", () => ({ authFetch: vi.fn() }));

const config = {
  schemaVersion: 1,
  context: { systemInstructions: "", modules: ["company_info"] },
  skills: { defaultSkillIds: [], allowlist: null, denylist: [] },
  mcp: { serverAllowlist: null, toolAllowlist: null, denyServers: [], denyTools: [] },
  memory: { scope: "full" },
  model: { strategy: "inherit" },
  limits: { maxTurns: null },
  capabilities: { shell: true, backgroundTasks: true, interaction: true, subagents: true, scheduling: true },
  tools: { allowlist: null, denylist: [] },
  execution: { allowedTargets: null },
};

const profile = {
  profileId: "arp_system_default_interactive",
  profileKey: "default_interactive",
  name: "默认交互 Agent",
  description: "个人主 Agent 的兼容运行预设。",
  purpose: "主 Agent",
  status: "published",
  systemProfile: true,
  draftConfig: config,
  draftDigest: "sha256:v1",
  revision: 1,
  latestVersion: {
    profileVersionId: "arpv_default_v1",
    profileId: "arp_system_default_interactive",
    versionNumber: 1,
    configDigest: "sha256:v1",
    publishedBy: "system",
    publishedAt: "2026-07-22T00:00:00.000Z",
  },
  updatedBy: "system",
  updatedAt: "2026-07-22T00:00:00.000Z",
};

function profilesResponse(): Response {
  return new Response(JSON.stringify({
    durable: true,
    profiles: [profile],
    bindings: [{
      bindingKey: "main",
      profileId: profile.profileId,
      updatedBy: "system",
      updatedAt: "2026-07-22T00:00:00.000Z",
    }],
    bindingKeys: ["main"],
    semantics: {
      shellWarning: "模型可见工具不等于安全权限",
      publishedVersionsImmutable: true,
      newSessionsOnly: true,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("AgentRuntimeProfilesManager", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockResolvedValue(profilesResponse());
  });

  it("明确展示 Shell 能力边界、版本与运行入口绑定", async () => {
    const user = userEvent.setup();
    render(<AgentRuntimeProfilesManager />);

    expect(await screen.findByText(/模型可见工具用于减少提示词和误调用，不等于安全权限/)).toBeTruthy();
    expect(screen.getByText("default_interactive · v1")).toBeTruthy();
    expect(screen.getByText(/绑定：默认交互 Agent/)).toBeTruthy();
    expect(screen.getByText("Shell：开放（不是权限边界）")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "场景绑定" }));
    expect(screen.getByText("默认交互 Agent", { selector: ".text-sm.font-medium" })).toBeTruthy();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(profile.profileId);
  });

  it("保存草稿时携带乐观锁 revision，且不会冒充热更新", async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockImplementation(async (_path, init) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ profile }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return profilesResponse();
    });
    render(<AgentRuntimeProfilesManager />);

    const name = await screen.findByDisplayValue("默认交互 Agent");
    await user.clear(name);
    await user.type(name, "默认交互 Agent 草稿");
    await user.click(screen.getByRole("button", { name: "保存草稿" }));

    expect(await screen.findByText("草稿已保存；尚未影响任何运行中的或新建会话")).toBeTruthy();
    const patchCall = vi.mocked(authFetch).mock.calls.find((call) => call[1]?.method === "PATCH");
    expect(patchCall?.[0]).toBe(`/api/admin/agent-profiles/${profile.profileId}/draft`);
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      expectedRevision: 1,
      name: "默认交互 Agent 草稿",
    });
  });
});
