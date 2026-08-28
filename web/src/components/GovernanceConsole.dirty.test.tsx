import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsDirtyBoundary, useSettingsDirtyEntry } from "@/components/PersonalSettings/dirtyRegistry";
import { SystemSettingsPanel } from "@/components/PlatformAdmin/SystemSettingsPanel";
import { TenantRemoteHandsManager } from "@/components/TenantRemoteHandsManager";
import { governanceRoute } from "@/lib/governanceNavigation";
import { GovernanceConsole } from "./GovernanceConsole";

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  tenants: [] as { id: string; name: string }[],
  scheduler: {
    status: "ok",
    sessionLockMode: "lease",
    maxConcurrentRuns: 8,
    executionEnabled: true,
    foregroundReservedRuns: 2,
    effectiveMaxConcurrentRuns: 8,
    maxConfigurableConcurrentRuns: 64,
    editable: true,
    inFlightRuns: 1,
    inFlightBackgroundRuns: 0,
    updatedAt: "2026-08-27T12:00:00.000Z",
  },
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ platformReadOnly: false, user: { tenantId: "pantheon" }, isPlatformAdmin: true }),
}));
vi.mock("@/components/PlatformAdmin/api", () => ({
  platformAdminApi: {
    alertingStatus: vi.fn().mockResolvedValue({ configured: false, webhookConfigured: false, notifyCount: 0 }),
    schedulerRuntimeConfig: vi.fn().mockResolvedValue({ runtimeScheduler: mocks.scheduler }),
    updateSchedulerRuntimeConfig: vi.fn().mockResolvedValue({ runtimeScheduler: mocks.scheduler }),
    sendTestAlert: vi.fn(),
  },
}));
vi.mock("@/lib/authFetch", () => ({ authFetch: mocks.authFetch }));
vi.mock("@/components/UserManager/hooks", () => ({ useUsers: () => ({ users: [], loading: false }) }));
vi.mock("@/components/TenantManager/hooks", () => ({ useTenants: () => ({ tenants: mocks.tenants, loading: false }) }));

function DirtyEditor() {
  const [value, setValue] = useState("基线");
  useSettingsDirtyEntry({
    id: "governance-organization-dirty-test",
    label: "公司信息",
    dirty: value !== "基线",
    save: () => undefined,
    discard: () => setValue("基线"),
  });
  return <input aria-label="组织草稿" value={value} onChange={(event) => setValue(event.target.value)} />;
}

describe("治理控制台 dirty boundary", () => {
  beforeEach(() => {
    mocks.tenants = [];
    window.history.replaceState({ __appHistoryIndex: 0 }, "", "/platform-console/overview/overview");
    window.history.pushState({ __appHistoryIndex: 1 }, "", "/platform-console/governance/system-settings");
    mocks.authFetch.mockReset().mockImplementation(async (input: string) => {
      if (input.includes("/acs/runtime-config")) {
        return jsonResponse({
          status: "ok",
          runtimeConfig: {
            maxRunningSandboxes: 20,
            warnRunningSandboxes: 15,
            minConfigurableRunningSandboxes: 1,
            maxConfigurableRunningSandboxes: 8_192,
            drainDeadlineMs: 300_000,
          },
        });
      }
      return jsonResponse({
        tenantRemoteHands: {
          hands: [{ id: "agent-saas-acs", description: "ACS", baseUrl: "http://acs:3400", rollout: { mode: "disabled" } }],
        },
      });
    });
  });

  it("真实 system-settings 路由修改后阻止治理侧栏与浏览器 Back", async () => {
    const onExit = vi.fn();
    render(
      <SettingsDirtyBoundary>
        {(dirtyController) => (
          <GovernanceConsole
            area="platform"
            route={governanceRoute("platform.governance.system-settings")}
            onExit={onExit}
            dirtyController={dirtyController}
          >
            <SystemSettingsPanel />
          </GovernanceConsole>
        )}
      </SettingsDirtyBoundary>,
    );

    const schedulerInput = await screen.findByLabelText("期望并发");
    await waitFor(() => expect((schedulerInput as HTMLInputElement).value).toBe("8"));
    fireEvent.change(schedulerInput, { target: { value: "12" } });

    await userEvent.click(screen.getByRole("button", { name: "运行与可观测" }));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.location.pathname).toBe("/platform-console/governance/system-settings");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    act(() => window.history.back());
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(window.location.pathname).toBe("/platform-console/governance/system-settings");
    expect(onExit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "放弃更改" }));
    await waitFor(() => expect(window.location.pathname).toBe("/platform-console/overview/overview"));
  });

  it("真实 execution-providers 路由的主表单修改后阻止治理侧栏", async () => {
    window.history.replaceState({ __appHistoryIndex: 1 }, "", "/platform-console/runtime/execution-providers");
    render(
      <SettingsDirtyBoundary>
        {(dirtyController) => (
          <GovernanceConsole
            area="platform"
            route={governanceRoute("platform.runtime.execution-providers")}
            onExit={() => undefined}
            dirtyController={dirtyController}
          >
            <TenantRemoteHandsManager />
          </GovernanceConsole>
        )}
      </SettingsDirtyBoundary>,
    );

    const description = await screen.findByPlaceholderText("例如 agent-saas-ecs");
    await waitFor(() => expect((description as HTMLInputElement).value).toBe("ACS"));
    fireEvent.change(description, { target: { value: "ACS 新草稿" } });
    await userEvent.click(screen.getByRole("button", { name: "总览" }));

    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(screen.getByText(/执行环境池尚未保存/)).toBeTruthy();
    expect(window.location.pathname).toBe("/platform-console/runtime/execution-providers");
  });

  it("组织治理作用域切换同样经过 dirty controller", async () => {
    mocks.tenants = [
      { id: "acme", name: "Acme" },
      { id: "beta", name: "Beta" },
    ];
    window.history.replaceState({ __appHistoryIndex: 1 }, "", "/tenant-admin/settings/profile?org=acme");
    render(
      <SettingsDirtyBoundary>
        {(dirtyController) => (
          <GovernanceConsole
            area="organization"
            route={governanceRoute("organization.settings.profile", { orgId: "acme" })}
            onExit={() => undefined}
            dirtyController={dirtyController}
          >
            <DirtyEditor />
          </GovernanceConsole>
        )}
      </SettingsDirtyBoundary>,
    );
    fireEvent.change(screen.getByLabelText("组织草稿"), { target: { value: "未保存公司信息" } });

    await userEvent.click(screen.getByRole("combobox", { name: "切换组织" }));
    await userEvent.click(screen.getByRole("option", { name: "Beta" }));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(window.location.search).toBe("?org=acme");

    await userEvent.click(screen.getByRole("combobox", { name: "切换组织" }));
    await userEvent.click(screen.getByRole("option", { name: "Beta" }));
    fireEvent.click(await screen.findByRole("button", { name: "放弃更改" }));
    await waitFor(() => expect(window.location.search).toBe("?org=beta"));
  });
});
