import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ContextCenterPage } from "./ContextCenterPage";
import type { ContextCenterApiPort, ContextCenterSnapshot, ContextEvidence } from "./types";

const snapshot: ContextCenterSnapshot = {
  generatedAt: "2026-08-22T15:40:00.000Z",
  sources: [
    {
      sourceId: "dingtalk-kb",
      name: "钉钉知识库",
      system: "钉钉",
      collectionId: "product-delivery",
      collection: "产品与交付",
      status: "healthy",
      lastSyncedAt: "2026-08-22T15:38:00.000Z",
      backfillCoverage: { kind: "items", coveredItems: 1200, totalItems: 2400 },
      watermarkLagSeconds: 120,
      ingestOutcomes: { truncated: 3, refused: 1, unreadable: 0 },
      historicalLearningScope: {
        enabled: true,
        summary: "产品空间内已授权的历史文档",
        from: "2026-01-01T00:00:00.000Z",
        through: "2026-08-01T00:00:00.000Z",
        includes: ["产品手册", "交付规范"],
      },
      realtimeListeningScope: {
        enabled: true,
        summary: "监听产品空间新建与更新事件",
        from: "2026-08-01T00:00:00.000Z",
        through: null,
        includes: ["文档更新"],
      },
    },
    {
      sourceId: "crm-notes",
      name: "CRM 跟进记录",
      system: "CRM",
      collectionId: "customer-voice",
      collection: "客户声音",
      status: "attention",
      lastSyncedAt: null,
      backfillCoverage: {
        kind: "time",
        coveredFrom: "2026-07-01T00:00:00.000Z",
        coveredThrough: "2026-08-20T00:00:00.000Z",
      },
      watermarkLagSeconds: null,
      ingestOutcomes: { truncated: 0, refused: 0, unreadable: 0 },
      historicalLearningScope: { enabled: true, summary: "已授权客户的历史跟进记录" },
      realtimeListeningScope: { enabled: false, summary: "实时事件订阅尚未配置" },
    },
  ],
  consumers: [
    {
      id: "answer-runtime",
      name: "回答运行时",
      kind: "Agent consumer",
      status: "lagging",
      watermarkAt: "2026-08-22T15:35:00.000Z",
      lagSeconds: 300,
      detail: "等待索引批次完成",
    },
  ],
};

const evidence: ContextEvidence[] = [
  {
    id: "ev-1",
    sourceName: "钉钉知识库",
    collection: "产品与交付",
    author: "王小明",
    occurredAt: "2026-08-20T02:30:00.000Z",
    quote: "交付验收前必须完成生产环境回归。",
    derived: true,
    freshness: "fresh",
    freshnessAsOf: "2026-08-22T15:38:00.000Z",
    originalUrl: "https://example.test/docs/acceptance",
  },
];

function createApi(nextSnapshot: ContextCenterSnapshot = snapshot) {
  const getSnapshot = vi.fn().mockResolvedValue(nextSnapshot);
  const listEvidence = vi.fn().mockResolvedValue(evidence);
  const api: ContextCenterApiPort = { getSnapshot, listEvidence };
  return { api, getSnapshot, listEvidence };
}

describe("ContextCenterPage", () => {
  it("展示来源同步口径、分开的学习/监听范围与 consumer 状态，且不推算百分比", async () => {
    const { api, getSnapshot } = createApi();
    render(<ContextCenterPage api={api} />);

    expect(await screen.findByRole("heading", { name: "钉钉知识库" })).toBeTruthy();
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(screen.getByText("1,200 / 2,400 条")).toBeTruthy();
    expect(screen.getByText("已覆盖时间 · 来源未提供总量")).toBeTruthy();
    expect(screen.getByText("截断 3")).toBeTruthy();
    expect(screen.getByText("拒绝 1")).toBeTruthy();
    expect(screen.getByText("不可读 0")).toBeTruthy();
    expect(screen.getAllByRole("region", { name: "历史学习范围" })).toHaveLength(2);
    expect(screen.getAllByRole("region", { name: "实时监听范围" })).toHaveLength(2);
    expect(screen.getByText("回答运行时")).toBeTruthy();
    expect(screen.getByText("有延迟")).toBeTruthy();
    expect(document.body.textContent).not.toContain("%");
  });

  it("按来源从注入的 API 加载 Evidence Drawer，并展示完整溯源字段", async () => {
    const { api, listEvidence } = createApi();
    render(<ContextCenterPage api={api} />);

    const evidenceButton = await screen.findByRole("button", { name: "查看 钉钉知识库 的 Evidence" });
    fireEvent.click(evidenceButton);

    await waitFor(() => expect(listEvidence).toHaveBeenCalledWith(
      { sourceId: "dingtalk-kb", collectionId: "product-delivery" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("王小明")).toBeTruthy();
    expect(within(drawer).getByText(/交付验收前必须完成生产环境回归/)).toBeTruthy();
    expect(within(drawer).getByText("派生证据")).toBeTruthy();
    expect(within(drawer).getByText("新鲜度：新鲜")).toBeTruthy();
    expect(within(drawer).getByText(/经原始记录加工/)).toBeTruthy();
    const originalLink = within(drawer).getByRole("link", { name: /在原系统中打开/ });
    expect(originalLink.getAttribute("href")).toBe("https://example.test/docs/acceptance");
    expect(originalLink.getAttribute("target")).toBe("_blank");
    expect(originalLink.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("无权限或服务端未挂载时诚实显示不可用，不注入回退数据", async () => {
    const getSnapshot = vi.fn().mockRejectedValue(new Error("当前账号无权查看 Context Center。"));
    const api: ContextCenterApiPort = { getSnapshot, listEvidence: vi.fn() };
    render(<ContextCenterPage api={api} />);

    expect(await screen.findByText("Context Center 暂不可用")).toBeTruthy();
    expect(screen.getByText("当前账号无权查看 Context Center。")).toBeTruthy();
    expect(screen.queryByText("钉钉知识库")).toBeNull();
  });

  it("后端未返回来源时只展示空状态，不填充 production 假数据", async () => {
    const { api } = createApi({ generatedAt: "2026-08-22T15:40:00.000Z", sources: [], consumers: [] });
    render(<ContextCenterPage api={api} />);

    expect(await screen.findByText("尚未接入上下文来源")).toBeTruthy();
    expect(screen.getByText("尚未上报 Consumer 状态")).toBeTruthy();
    expect(screen.queryByText("钉钉知识库")).toBeNull();
  });
});
