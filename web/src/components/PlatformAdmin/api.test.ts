import { beforeEach, describe, expect, it, vi } from "vitest";

const authFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/authFetch", () => ({ authFetch: authFetchMock }));

import { buildAdminApiPath, platformAdminApi } from "./api";

function eventStoreFixture() {
  return {
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
      watermarks: { legal: null, billing: null, effective: null, maxGlobalSequence: null, lag: null },
      categories: {},
    },
    capacity: {
      available: false,
      tableName: "runtime_events",
      totalBytes: null,
      tableBytes: null,
      indexBytes: null,
      sampledAt: null,
      stale: false,
      series: [],
    },
  };
}

describe("platform admin api", () => {
  beforeEach(() => authFetchMock.mockReset());

  it("builds admin paths with encoded query params and skips empty values", () => {
    expect(buildAdminApiPath("/sessions", {
      tenantId: "kaiyan",
      userId: "",
      includeDeleted: true,
      cursor: "a+b/c",
      limit: 50,
    })).toBe("/api/admin/sessions?tenantId=kaiyan&includeDeleted=true&cursor=a%2Bb%2Fc&limit=50");
  });

  it("keeps paths query-free when all values are empty", () => {
    expect(buildAdminApiPath("/tenants/overview", {
      tenantId: "",
      cursor: null,
      q: undefined,
    })).toBe("/api/admin/tenants/overview");
  });

  it("builds system observability paths", () => {
    expect(buildAdminApiPath("/system/metrics", { hours: 24 })).toBe("/api/admin/system/metrics?hours=24");
    expect(buildAdminApiPath("/system/event-store", { hours: 24 })).toBe("/api/admin/system/event-store?hours=24");
    expect(buildAdminApiPath("/system/storage/scan")).toBe("/api/admin/system/storage/scan");
    expect(buildAdminApiPath("/system/storage/delete")).toBe("/api/admin/system/storage/delete");
  });

  it("accepts a complete EventStore status response", async () => {
    authFetchMock.mockResolvedValue(new Response(JSON.stringify(eventStoreFixture()), { status: 200 }));

    await expect(platformAdminApi.eventStoreStatus()).resolves.toMatchObject({
      schemaVersion: 1,
      retention: { status: "execute_succeeded" },
      capacity: { available: false },
    });
  });

  it.each([
    ["", "空响应"],
    ["{bad-json", "坏 JSON"],
    [JSON.stringify({ schemaVersion: 1 }), "缺失字段"],
    [JSON.stringify({ ...eventStoreFixture(), retention: { ...eventStoreFixture().retention, status: "future_status" } }), "未知状态"],
    [JSON.stringify({
      ...eventStoreFixture(),
      capacity: {
        ...eventStoreFixture().capacity,
        available: true,
        sampledAt: "2026-08-29T14:00:00.000Z",
        totalBytes: 140,
      },
    }), "旧格式可用容量仍缺 table/index 字段"],
  ])("rejects 2xx %s rather than replacing trusted EventStore data (%s)", async (body) => {
    authFetchMock.mockResolvedValue(new Response(body, { status: 200 }));

    await expect(platformAdminApi.eventStoreStatus()).rejects.toThrow("EventStore 状态响应无效");
  });
});
