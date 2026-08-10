import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GovernanceChangeAuditPage } from "./GovernanceChangeAuditPage";

const mocks = vi.hoisted(() => ({ listAuditEvents: vi.fn() }));
vi.mock("@agent/shared/lib/governanceApi", () => ({ governanceAccessApi: { listAuditEvents: mocks.listAuditEvents } }));

describe("GovernanceChangeAuditPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("按组织作用域读取权威治理账本", async () => {
    mocks.listAuditEvents.mockResolvedValue({ events: [{
      auditId: "audit-1", changeId: "change-1", actorUserId: "owner-1", actorPersona: "org_admin",
      action: "membership.update", targetType: "membership", targetId: "member-1", purpose: "identity_governance",
      result: "succeeded", occurredAt: "2026-08-10T10:00:00.000Z",
    }] });
    render(<GovernanceChangeAuditPage tenantId="tenant-a" />);
    expect(await screen.findByText("membership.update")).toBeTruthy();
    expect(screen.getByText("change-1")).toBeTruthy();
    expect(mocks.listAuditEvents).toHaveBeenCalledWith({ tenantId: "tenant-a", limit: 100 });
  });

  it("查询不可用时 fail closed", async () => {
    mocks.listAuditEvents.mockRejectedValue(new Error("503"));
    render(<GovernanceChangeAuditPage />);
    expect(await screen.findByText("权威治理结论暂不可获得")).toBeTruthy();
  });
});
