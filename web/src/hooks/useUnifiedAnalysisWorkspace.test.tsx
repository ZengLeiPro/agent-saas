import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ScopeFilters } from "@/components/PlatformAdmin/common";
import { UnifiedAnalysisSidebar } from "@/components/UnifiedAnalysisSidebar";
import { HISTORY_PUSH, useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";
import type { ManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";
import { governanceRoute } from "@/lib/governanceNavigation";
import { useUnifiedAnalysisWorkspace } from "./useUnifiedAnalysisWorkspace";

const users = vi.fn();

vi.mock("@/components/PlatformAdmin/api", () => ({
  platformAdminApi: {
    users: (...args: unknown[]) => users(...args),
  },
}));

vi.mock("@/components/TenantManager/hooks", () => ({
  useTenants: () => ({ tenants: [{ id: "acme", name: "Acme" }] }),
}));

const access: ManagementSettingsAccess = {
  status: "ready",
  personalAllowed: true,
  tenantEntryAllowed: true,
  platformEntryAllowed: true,
  retry: vi.fn(),
};

function Harness() {
  const adminQuery = useAdminUrlQuery();
  const workspace = useUnifiedAnalysisWorkspace({
    mode: true,
    governanceRoute: governanceRoute("platform.runtime.sessions"),
    managementAccess: access,
    sessionId: "session-1",
    pushActiveTab: vi.fn(),
    setActiveTab: vi.fn(),
  });

  return (
    <>
      <ScopeFilters
        tenantId={adminQuery.get("tenantId") ?? ""}
        userId={adminQuery.get("userId") ?? ""}
        onChange={(values) => adminQuery.patch(values, HISTORY_PUSH)}
      />
      <button
        type="button"
        onClick={() => adminQuery.patch({ status: "failed", hours: 168 }, HISTORY_PUSH)}
      >
        添加页面私有筛选
      </button>
      <UnifiedAnalysisSidebar
        width={280}
        hidden={false}
        access={access}
        route={governanceRoute("platform.runtime.sessions")}
        onNavigate={workspace.navigate}
        onClose={workspace.close}
        onResizeMouseDown={vi.fn()}
        onResizeDoubleClick={vi.fn()}
        footer={<div>footer</div>}
      />
    </>
  );
}

describe("统一分析工作区实时作用域导航", () => {
  beforeEach(() => {
    users.mockReset().mockResolvedValue({
      items: [{ id: "u1", username: "zhang", realName: "张三", tenantId: "acme", role: "user", disabled: false }],
    });
    window.history.replaceState(
      { analysisWorkspace: { source: "/chat/session-1", depth: 1 } },
      "",
      "/platform-console/runtime/sessions",
    );
  });

  it("页内动态选择组织和用户后切换分析项仍保留实时作用域", async () => {
    render(<Harness />);

    await userEvent.click(screen.getByLabelText("按组织筛选"));
    await userEvent.click(await screen.findByRole("option", { name: "Acme" }));
    await userEvent.click(screen.getByLabelText("按用户筛选"));
    await userEvent.click(await screen.findByRole("option", { name: "张三（zhang）" }));
    await userEvent.click(screen.getByRole("button", { name: "添加页面私有筛选" }));

    await waitFor(() => expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({
      hours: "168",
      status: "failed",
      tenantId: "acme",
      userId: "u1",
    }));

    await userEvent.click(screen.getByRole("button", { name: "运行追踪" }));

    expect(window.location.pathname).toBe("/platform-console/runtime/runs");
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({
      tenantId: "acme",
      userId: "u1",
    });
  });
});
