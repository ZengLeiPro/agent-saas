import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventStoreStatusResponse, SystemMetricsResponse, SystemStorageResponse } from "../types";

const api = vi.hoisted(() => ({
  systemMetrics: vi.fn(),
  systemStorage: vi.fn(),
  eventStoreStatus: vi.fn(),
  triggerStorageScan: vi.fn(),
  archiveWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock("../api", () => ({ platformAdminApi: api }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ platformReadOnly: true }) }));

import { InfraPage } from "./InfraPage";

const metrics: SystemMetricsResponse = { available: true, latest: [], series: [], generatedAt: "2026-08-29T14:00:00.000Z" };
const storage: SystemStorageResponse = {
  available: true,
  summary: { totalBytes: 0, orphanBytes: 0, orphanCount: 0, byTenant: [], lastScanAt: null },
  workspaces: [],
  orphans: [],
  generatedAt: "2026-08-29T14:00:00.000Z",
};
const eventStore: EventStoreStatusResponse = {
  schemaVersion: 1,
  available: true,
  generatedAt: "2026-08-29T14:00:00.000Z",
  retention: {
    enabled: true,
    mode: "execute",
    status: "execute_succeeded",
    stale: false,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSuccessAt: null,
    durationMs: null,
    errorCategory: null,
    nextScheduledAt: null,
    watermarks: { legal: null, billing: "billing-marker-321", effective: "effective-marker-321", maxGlobalSequence: null, lag: "7" },
    categories: {},
  },
  capacity: { available: false, tableName: null, totalBytes: null, tableBytes: null, indexBytes: null, sampledAt: null, stale: false, series: [] },
};

describe("InfraPage EventStore loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.systemMetrics.mockResolvedValue(metrics);
    api.systemStorage.mockResolvedValue(storage);
    api.eventStoreStatus.mockResolvedValue(eventStore);
  });

  it("初始加载与 metrics/storage 并行请求 hours=24", async () => {
    render(<InfraPage />);
    expect(await screen.findByText("billing-marker-321")).toBeTruthy();
    expect(api.systemMetrics).toHaveBeenCalledTimes(1);
    expect(api.systemStorage).toHaveBeenCalledTimes(1);
    expect(api.eventStoreStatus).toHaveBeenCalledWith({ hours: 24 });
  });

  it("后续刷新 EventStore 失败时显示错误并保留最近可信值", async () => {
    render(<InfraPage />);
    expect(await screen.findByText("billing-marker-321")).toBeTruthy();

    api.eventStoreStatus.mockRejectedValueOnce(new Error("event-store refresh failed"));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => expect(screen.getByText(/event-store refresh failed/)).toBeTruthy());
    expect(screen.getByText("billing-marker-321")).toBeTruthy();
    expect(screen.getByText(/刷新失败；当前显示最近一次可信数据/)).toBeTruthy();
    expect(api.eventStoreStatus).toHaveBeenLastCalledWith({ hours: 24 });
  });

  it("初始 EventStore 响应无效时明确显示状态不可用", async () => {
    api.eventStoreStatus.mockRejectedValueOnce(new Error("EventStore 状态响应无效"));

    render(<InfraPage />);

    expect(await screen.findByText("EventStore 状态不可用")).toBeTruthy();
    expect(screen.getByText(/当前不能判断为健康/)).toBeTruthy();
    expect(screen.queryByText("健康")).toBeNull();
  });
});
