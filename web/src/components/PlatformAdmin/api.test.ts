import { beforeEach, describe, expect, it, vi } from "vitest";

const authFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/authFetch", () => ({ authFetch: authFetchMock }));

import { buildAdminApiPath, platformAdminApi } from "./api";
import type { EventStoreStatusResponse } from "./types";

function eventStoreFixture(): EventStoreStatusResponse {
  return {
    schemaVersion: 1,
    available: true,
    generatedAt: "2026-08-29T14:00:00.000Z",
    retention: {
      enabled: true,
      mode: "execute",
      status: "execute_succeeded",
      stale: false,
      lastStartedAt: "2026-08-29T13:59:59.000Z",
      lastCompletedAt: "2026-08-29T14:00:00.000Z",
      lastSuccessAt: "2026-08-29T14:00:00.000Z",
      durationMs: 1_000,
      errorCategory: null,
      nextScheduledAt: "2026-08-29T14:10:00.000Z",
      watermarks: { legal: "100", billing: "90", effective: "90", maxGlobalSequence: "110", lag: "20" },
      categories: {
        "tool-delta": { eligible: 2, deleted: 2 },
        "assistant-stream": { eligible: 0, deleted: 0 },
        "tool-stream-summary": { eligible: 0, deleted: 0 },
        "model-diagnostics": { eligible: 0, deleted: 0 },
        "model-request-finished": { eligible: 0, deleted: 0 },
        "hand-events": { eligible: 0, deleted: 0 },
      },
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
    ["execute_succeeded", null],
    ["failed", "execution_failed"],
    ["blocked", "authorization_missing"],
  ] as const)("accepts stale freshness without replacing the latest %s result", async (status, errorCategory) => {
    const fixture = eventStoreFixture();
    fixture.retention.status = status;
    fixture.retention.stale = true;
    fixture.retention.errorCategory = errorCategory;
    authFetchMock.mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));

    await expect(platformAdminApi.eventStoreStatus()).resolves.toMatchObject({
      retention: { status, stale: true, errorCategory },
    });
  });

  it("accepts a complete scheduled startup status", async () => {
    const fixture = eventStoreFixture();
    fixture.retention = {
      ...fixture.retention,
      status: "scheduled",
      lastStartedAt: null,
      lastCompletedAt: null,
      durationMs: null,
      nextScheduledAt: "2026-08-29T14:10:00.000Z",
      watermarks: { legal: "100", billing: null, effective: null, maxGlobalSequence: null, lag: null },
      categories: {},
    };
    authFetchMock.mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));

    await expect(platformAdminApi.eventStoreStatus()).resolves.toMatchObject({
      retention: { mode: "execute", status: "scheduled", nextScheduledAt: "2026-08-29T14:10:00.000Z" },
    });
  });

  it.each([
    ["", "空响应"],
    ["{bad-json", "坏 JSON"],
    [JSON.stringify({ schemaVersion: 1 }), "缺失字段"],
    [JSON.stringify({ ...eventStoreFixture(), retention: { ...eventStoreFixture().retention, status: "future_status" } }), "未知状态"],
    [JSON.stringify({
      ...eventStoreFixture(),
      retention: { ...eventStoreFixture().retention, status: "failed", errorCategory: "db down" },
    }), "错误类别包含原始错误文本"],
    [JSON.stringify({
      ...eventStoreFixture(),
      retention: { ...eventStoreFixture().retention, status: "failed", errorCategory: "future_error_category" },
    }), "错误类别不是稳定白名单值"],
    [JSON.stringify({ ...eventStoreFixture(), retention: { ...eventStoreFixture().retention, status: "stale", stale: true } }), "用 status 覆盖 freshness"],
    [JSON.stringify({
      ...eventStoreFixture(),
      retention: {
        ...eventStoreFixture().retention,
        status: "scheduled",
        lastStartedAt: null,
        lastCompletedAt: null,
        durationMs: null,
        watermarks: { legal: "100", billing: "1", effective: "1", maxGlobalSequence: "1", lag: "0" },
        categories: {},
      },
    }), "scheduled 携带进度水位"],
    [JSON.stringify({
      ...eventStoreFixture(),
      retention: {
        ...eventStoreFixture().retention,
        status: "running",
        lastCompletedAt: null,
        durationMs: null,
        watermarks: { legal: "100", billing: null, effective: null, maxGlobalSequence: null, lag: null },
      },
    }), "running 携带分类进度"],
    [JSON.stringify({ ...eventStoreFixture(), retention: { ...eventStoreFixture().retention, lastSuccessAt: null } }), "成功状态缺失成功时间"],
    [JSON.stringify({ ...eventStoreFixture(), retention: { ...eventStoreFixture().retention, lastCompletedAt: "not-a-time" } }), "成功状态时间非法"],
    [JSON.stringify({ ...eventStoreFixture(), retention: { ...eventStoreFixture().retention, lastSuccessAt: "2099-01-01T00:00:00.000Z" } }), "成功状态时间晚于响应"],
    [JSON.stringify({ ...eventStoreFixture(), retention: { ...eventStoreFixture().retention, durationMs: -1 } }), "成功状态耗时为负数"],
    [JSON.stringify({
      ...eventStoreFixture(),
      retention: {
        ...eventStoreFixture().retention,
        watermarks: { ...eventStoreFixture().retention.watermarks, maxGlobalSequence: "-1" },
      },
    }), "成功状态最大序号非法"],
    [JSON.stringify({
      ...eventStoreFixture(),
      retention: {
        ...eventStoreFixture().retention,
        watermarks: { ...eventStoreFixture().retention.watermarks, maxGlobalSequence: "80" },
      },
    }), "成功状态水位顺序矛盾"],
    [JSON.stringify({
      ...eventStoreFixture(),
      retention: {
        ...eventStoreFixture().retention,
        watermarks: { ...eventStoreFixture().retention.watermarks, lag: "21" },
      },
    }), "成功状态 lag 不一致"],
    [JSON.stringify({ ...eventStoreFixture(), retention: { ...eventStoreFixture().retention, categories: {} } }), "成功状态分类为空"],
    [JSON.stringify({
      ...eventStoreFixture(),
      capacity: {
        ...eventStoreFixture().capacity,
        available: true,
        sampledAt: "2026-08-29T14:00:00.000Z",
        totalBytes: 140,
      },
    }), "旧格式可用容量仍缺 table/index 字段"],
    [JSON.stringify({
      ...eventStoreFixture(),
      capacity: {
        available: true,
        tableName: "runtime_events",
        totalBytes: 140,
        tableBytes: 100,
        indexBytes: 40,
        sampledAt: "2099-01-01T00:00:00.000Z",
        stale: false,
        series: [
          { totalBytes: 120, tableBytes: 90, indexBytes: 30, sampledAt: "2098-12-31T23:00:00.000Z" },
          { totalBytes: 140, tableBytes: 100, indexBytes: 40, sampledAt: "2099-01-01T00:00:00.000Z" },
        ],
      },
    }), "容量快照与趋势晚于响应生成时间"],
    [JSON.stringify({
      ...eventStoreFixture(),
      generatedAt: "2099-01-01T00:00:00.000Z",
      capacity: {
        available: true,
        tableName: "runtime_events",
        totalBytes: 140,
        tableBytes: 100,
        indexBytes: 40,
        sampledAt: "2099-01-01T00:00:00.000Z",
        stale: false,
        series: [
          { totalBytes: 140, tableBytes: 100, indexBytes: 40, sampledAt: "2099-01-01T00:00:00.000Z" },
        ],
      },
    }), "响应与容量时间同时伪造到未来"],
    [JSON.stringify({
      ...eventStoreFixture(),
      capacity: {
        available: true,
        tableName: "runtime_events",
        totalBytes: 140,
        tableBytes: 100,
        indexBytes: 40,
        sampledAt: "2026-08-29T14:00:00.000Z",
        stale: false,
        series: [
          { totalBytes: 140, tableBytes: 100, indexBytes: 40, sampledAt: "2099-01-01T00:00:00.000Z" },
        ],
      },
    }), "单个容量趋势样本晚于响应生成时间"],
  ])("rejects an invalid 2xx body rather than replacing trusted EventStore data (%s)", async (body) => {
    authFetchMock.mockResolvedValue(new Response(body, { status: 200 }));

    await expect(platformAdminApi.eventStoreStatus()).rejects.toThrow("EventStore 状态响应无效");
  });
});
