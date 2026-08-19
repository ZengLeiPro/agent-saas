import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GovernanceChangeAuditPage } from "./GovernanceChangeAuditPage";

const mocks = vi.hoisted(() => ({ listAuditEvents: vi.fn() }));
vi.mock("@agent/shared/lib/governanceApi", () => ({ governanceAccessApi: { listAuditEvents: mocks.listAuditEvents } }));

function event(overrides: Record<string, unknown> = {}) {
  return {
    auditId: "audit-1",
    changeId: "change-1",
    actorUserId: "owner-1",
    actorPersona: "org_admin",
    action: "membership.update",
    targetType: "membership",
    targetId: "member-1",
    targetTenantId: "tenant-a",
    purpose: "identity_governance",
    result: "succeeded",
    occurredAt: "2026-08-10T10:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("GovernanceChangeAuditPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("按组织作用域读取权威治理账本，并防御性隐藏错租户事件", async () => {
    mocks.listAuditEvents.mockResolvedValue({ events: [
      event(),
      event({ auditId: "cross-tenant", targetTenantId: "tenant-b", action: "should.not.render" }),
    ] });
    render(<GovernanceChangeAuditPage tenantId="tenant-a" />);
    expect((await screen.findAllByText("membership.update")).length).toBeGreaterThan(0);
    expect(screen.getByText("change-1")).toBeTruthy();
    expect(screen.queryByText("should.not.render")).toBeNull();
    expect(mocks.listAuditEvents).toHaveBeenCalledWith({ tenantId: "tenant-a", limit: 100 });
  });

  it("支持搜索、动作/结果/日期筛选、同因失败聚合与前端分页", async () => {
    const events = Array.from({ length: 22 }, (_, index) => event({
      auditId: `audit-${index}`,
      changeId: `change-${index}`,
      actorUserId: index === 21 ? "needle-owner" : `owner-${index}`,
      action: index < 2 ? "tenant.delete" : "membership.update",
      result: index < 2 ? "failed" : "succeeded",
      occurredAt: index === 21 ? "2026-08-11T10:00:00.000Z" : "2026-08-10T10:00:00.000Z",
      metadata: index < 2 ? { errorCode: "TENANT_DELETE_FAILED" } : {},
    }));
    mocks.listAuditEvents.mockResolvedValue({ events });
    render(<GovernanceChangeAuditPage tenantId="tenant-a" />);

    expect(await screen.findByText("同因失败聚合")).toBeTruthy();
    expect(screen.getAllByText("TENANT_DELETE_FAILED").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("2 次")).toBeTruthy();
    expect(screen.getByText(/第 1 \/ 2 页/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText(/第 2 \/ 2 页/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("搜索治理审计"), { target: { value: "needle-owner" } });
    expect(screen.getByText("needle-owner")).toBeTruthy();
    expect(screen.getByText(/第 1 \/ 1 页/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("搜索治理审计"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("按动作筛选"), { target: { value: "tenant.delete" } });
    fireEvent.change(screen.getByLabelText("按结果筛选"), { target: { value: "failed" } });
    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2026-08-10" } });
    fireEvent.change(screen.getByLabelText("结束日期"), { target: { value: "2026-08-10" } });
    expect(screen.getAllByText("tenant.delete").length).toBeGreaterThanOrEqual(2);
  });

  it("使用 nextBefore 从权威治理账本加载更早一页", async () => {
    mocks.listAuditEvents
      .mockResolvedValueOnce({ events: [event()], nextBefore: "2026-08-10T10:00:00.000Z" })
      .mockResolvedValueOnce({ events: [event({ auditId: "audit-old", changeId: "change-old", occurredAt: "2026-08-09T10:00:00.000Z" })] });
    render(<GovernanceChangeAuditPage tenantId="tenant-a" />);
    await screen.findByText("change-1");
    fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
    await waitFor(() => expect(screen.getByText("change-old")).toBeTruthy());
    expect(mocks.listAuditEvents).toHaveBeenLastCalledWith({
      tenantId: "tenant-a",
      before: "2026-08-10T10:00:00.000Z",
      limit: 100,
    });
  });

  it("查询不可用时 fail closed", async () => {
    mocks.listAuditEvents.mockRejectedValue(new Error("503"));
    render(<GovernanceChangeAuditPage />);
    expect(await screen.findByText("权限服务暂不可用")).toBeTruthy();
  });
});
